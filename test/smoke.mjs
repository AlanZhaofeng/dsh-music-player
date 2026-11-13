/**
 * 本地冒烟测试：用假的 cordis ctx / webServer / HTTP 对象直接调用 index.js 注册的路由，
 * 不安装插件、不碰 profile，就能验证「搜索 → 取地址 → 取流(Range) → 下载落盘」整条链路。
 *
 *   node test/smoke.mjs
 */
import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import { stat, rm } from 'node:fs/promises'
import { apply } from '../index.js'

const PREFIX = '/dsh-music-player'

class FakeReq extends EventEmitter {
  constructor(url, method = 'GET', headers = {}, body = '') {
    super()
    this.url = url
    this.method = method
    this.headers = headers
    this.body = body
  }
  async *[Symbol.asyncIterator]() {
    if (this.body) yield Buffer.from(this.body)
  }
}

class FakeRes extends Writable {
  constructor() {
    super()
    this.chunks = []
    this.status = 0
    this.headers = {}
    this.headersSent = false
  }
  writeHead(status, headers) {
    this.status = status
    this.headers = headers || {}
    this.headersSent = true
  }
  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk))
    callback()
  }
  get body() {
    return Buffer.concat(this.chunks)
  }
  get text() {
    return this.body.toString('utf8')
  }
}

const routes = new Map()
const webServer = {
  getOrigin: () => 'http://127.0.0.1:0',
  register: ({ path, handler }) => {
    routes.set(path, handler)
    return () => routes.delete(path)
  },
}

const ctx = {
  get: (name) => (name === 'webServer' ? webServer : undefined),
  inject: (deps, callback) => {
    if (deps.includes('webServer')) callback({ ...ctx, webServer })
  },
  effect: (factory) => {
    factory()
    return () => {}
  },
  logger: { info: (message) => console.log('   ·', message) },
}

apply(ctx)

let failures = 0
const mb = (bytes) => (Number(bytes) / 1048576).toFixed(1)
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures += 1
}

const call = async (path, query = {}, init = {}) => {
  const handler = routes.get(PREFIX + path)
  if (!handler) throw new Error(`路由未注册：${PREFIX}${path}`)
  const qs = new URLSearchParams(query).toString()
  const req = new FakeReq(`${PREFIX}${path}${qs ? `?${qs}` : ''}`, init.method, init.headers, init.body)
  const res = new FakeRes()
  await handler(req, res)
  return res
}

console.log('注册的路由：', [...routes.keys()].join(', '))

// 1) health
{
  const res = await call('/health')
  const body = JSON.parse(res.text)
  check('/health 200', res.status === 200, `upstream=${body.upstream} ${body.probeMs}ms`)
  check('上游可达', body.upstream === 'ok', body.upstreamError)
  console.log('     下载目录：', body.downloadDir)
}

// 2) 搜索
let first = null
{
  const res = await call('/api', { types: 'search', source: 'netease', name: '周杰伦', count: '5', pages: '1' })
  const list = JSON.parse(res.text)
  check('/api search 200', res.status === 200)
  check('搜索返回非空数组', Array.isArray(list) && list.length > 0, `${Array.isArray(list) ? list.length : 'N/A'} 条`)
  first = Array.isArray(list) ? list[0] : null
  if (first) console.log(`     首条：${first.name} — ${[].concat(first.artist).join('、')}`)
}

// 3) 参数校验
{
  const bad = await call('/api', { types: 'drop table' })
  check('非法 types → 400', bad.status === 400, bad.text)
  const missing = await call('/api', { types: 'search' })
  check('search 缺 name → 400', missing.status === 400)
}

// 4) 取播放地址
let audioUrl = ''
{
  const res = await call('/api', { types: 'url', source: 'netease', id: String(first.id), br: '320' })
  const info = JSON.parse(res.text)
  check('/api url 200', res.status === 200)
  check('拿到音频地址', typeof info.url === 'string' && info.url.startsWith('https://'), `${info.br}kbps ${mb(info.size)}MB`)
  audioUrl = info.url || ''
}

// 5) 取流（带 Range）
if (audioUrl) {
  const res = await call('/proxy', { u: audioUrl }, { headers: { range: 'bytes=0-2047' } })
  check('/proxy 206', res.status === 206, `content-type=${res.headers['content-type']} len=${res.body.length}`)
  check('Range 生效（拿到 2KB）', res.body.length === 2048, `实际 ${res.body.length} 字节`)
  check('透传 content-range', Boolean(res.headers['content-range']), res.headers['content-range'] || '')
}

// 6) proxy 的 SSRF 防护
{
  const res = await call('/proxy', { u: 'http://127.0.0.1:61063/api' })
  check('内网地址被拒 → 400', res.status === 400, res.text)
  const res2 = await call('/proxy', { u: 'http://music.126.net/x.mp3' })
  check('非 https 被拒 → 400', res2.status === 400)
}

// 7) 封面地址
{
  const pic = await call('/api', { types: 'pic', source: 'netease', id: String(first.pic_id), size: '300' })
  const info = JSON.parse(pic.text)
  check('/api pic 返回图片地址', typeof info.url === 'string' && info.url.startsWith('https://'))
}

// 8) 下载落盘（用封面小图跑完整链路，跑完删掉）
{
  const pic = await call('/api', { types: 'pic', source: 'netease', id: String(first.pic_id), size: '300' })
  const picUrl = JSON.parse(pic.text).url
  const start = await call('/download', {}, {
    method: 'POST',
    body: JSON.stringify({ u: picUrl, filename: '测试/非法:名字?.jpg' }),
  })
  const started = JSON.parse(start.text)
  check('/download 受理', start.status === 200 && started.ok === true, `task=${started.task?.id} 文件名=${started.task?.filename}`)
  check('文件名已清洗', !/[\\/:*?"<>|]/.test(started.task?.filename || 'x'), started.task?.filename)

  let task = null
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    const res = await call('/tasks')
    task = JSON.parse(res.text).tasks.find((item) => item.id === started.task.id)
    if (task && task.state !== 'downloading') break
  }
  check('任务完成', task?.state === 'done', `state=${task?.state} ${task?.error || ''}`)
  if (task?.path) {
    const info = await stat(task.path)
    check('文件已落盘', info.size > 0, `${info.size} 字节 → ${task.path}`)
    await rm(task.path, { force: true })
    console.log('     （测试文件已删除）')
  }
}

// 9) 词接口（备用，不在 v1 UI 里）
{
  const res = await call('/api', { types: 'lyric', source: 'netease', id: String(first.lyric_id) })
  const info = JSON.parse(res.text)
  check('/api lyric 200', res.status === 200 && typeof info.lyric === 'string', `${(info.lyric || '').length} 字`)
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
