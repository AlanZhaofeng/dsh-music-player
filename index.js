/**
 * dsh-music-player —— 宿主半边（Host）。
 *
 * 上游是 GD 音乐台 API：https://music-api.gdstudio.xyz/api.php
 * 浏览器半边不直连上游，全部走这里的本地路由，原因有三：
 *   1) 上游 API 不带 CORS 头，浏览器 fetch 会被同源策略拦掉；
 *   2) 音频/封面 CDN 在部分网络环境下浏览器端 TLS 握手不稳定，宿主 Node 的 fetch 更稳；
 *   3) 下载要落盘，只能宿主做。
 *
 * 路由（前缀 PREFIX）：
 *   GET  /api?types=search|url|pic|lyric&...   透传上游 JSON（带 TTL 缓存，帮上游省配额）
 *   GET  /proxy?u=<encoded>                    音频/封面字节透传，支持 Range（拖动进度必需）
 *   POST /download {u, filename}               起一个落盘任务，立即返回 taskId
 *   GET  /tasks                                任务列表（进度 / 结果路径）
 *   GET  /health                               自检 + 下载目录
 */

import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'

export const name = 'music-player'

/** 上游 API 根地址。 */
const UPSTREAM = 'https://music-api.gdstudio.xyz/api.php'
/** 本地路由前缀，浏览器半边与之保持一致。 */
const PREFIX = '/dsh-music-player'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

const ALLOWED_TYPES = new Set(['search', 'url', 'pic', 'lyric'])
const ALLOWED_PARAMS = ['source', 'name', 'id', 'count', 'pages', 'br', 'size']
const ALLOWED_BR = new Set(['128', '192', '320', '740', '999'])

/** 上游限流 5 分钟 50 次，缓存能省掉翻页/重播的重复请求。 */
const CACHE_TTL = { search: 180_000, url: 60_000, lyric: 600_000, pic: 600_000 }
const CACHE_MAX = 200

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const cache = new Map()

function cacheGet(key) {
  const hit = cache.get(key)
  if (!hit) return undefined
  if (Date.now() - hit.at > hit.ttl) {
    cache.delete(key)
    return undefined
  }
  // 触碰一下，维持 LRU 顺序
  cache.delete(key)
  cache.set(key, hit)
  return hit
}

function cacheSet(key, payload, ttl) {
  cache.set(key, { at: Date.now(), ttl, ...payload })
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
}

// ---------------------------------------------------------------- 校验

/** 只允许 https 公网地址，挡掉内网/本机（这个路由能被页面调用，不能变成 SSRF 跳板）。 */
function assertRemoteUrl(raw) {
  let url
  try {
    url = new URL(String(raw || ''))
  } catch {
    throw new HttpError(400, '音频地址不合法')
  }
  if (url.protocol !== 'https:') throw new HttpError(400, '只允许 https 地址')
  const host = url.hostname.toLowerCase()
  const blocked =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === '[::1]' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^0\./.test(host)
  if (blocked) throw new HttpError(400, '不允许访问内网地址')
  return url
}

function readParams(query) {
  const type = String(query.get('types') || '')
  if (!ALLOWED_TYPES.has(type)) throw new HttpError(400, `types 必须是 ${[...ALLOWED_TYPES].join(' / ')}`)
  const params = new URLSearchParams({ types: type })
  for (const key of ALLOWED_PARAMS) {
    const value = query.get(key)
    if (value !== null && value !== '') params.set(key, value)
  }
  if (type === 'search' && !params.get('name')) throw new HttpError(400, '搜索需要 name')
  if ((type === 'url' || type === 'pic' || type === 'lyric') && !params.get('id'))
    throw new HttpError(400, `${type} 需要 id`)
  if (params.has('count')) {
    const count = Number(params.get('count'))
    if (!Number.isFinite(count) || count < 1 || count > 50) throw new HttpError(400, 'count 取值 1~50')
  }
  if (params.has('pages')) {
    const pages = Number(params.get('pages'))
    if (!Number.isFinite(pages) || pages < 1 || pages > 100) throw new HttpError(400, 'pages 取值 1~100')
  }
  if (params.has('br') && !ALLOWED_BR.has(params.get('br'))) {
    throw new HttpError(400, `br 只能是 ${[...ALLOWED_BR].join(' / ')}`)
  }
  return { type, params }
}

// ---------------------------------------------------------------- 下载目录

function downloadDir() {
  const override = process.env.DSH_MUSIC_DOWNLOAD_DIR
  if (override) return override
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const downloads = join(homedir(), 'Downloads')
  return existsSync(downloads) ? join(downloads, 'DSH音乐') : join(home, 'music-player', 'downloads')
}

function sanitizeFilename(raw) {
  let filename = String(raw || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // 清洗后可能留下「名字 .mp3」这种扩展名前的空格
  filename = filename.replace(/\s+(\.[a-z0-9]{2,5})$/i, '$1')
  if (!filename) filename = 'track'
  if (filename.length > 110) filename = filename.slice(0, 110).trim()
  if (!/\.[a-z0-9]{2,5}$/i.test(filename)) filename += '.mp3'
  return filename
}

function uniquePath(dir, filename) {
  const dot = filename.lastIndexOf('.')
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  const ext = dot > 0 ? filename.slice(dot) : ''
  let candidate = join(dir, filename)
  for (let i = 1; existsSync(candidate) && i < 1000; i += 1) {
    candidate = join(dir, `${stem} (${i})${ext}`)
  }
  return candidate
}

// ---------------------------------------------------------------- 响应工具

const sendJson = (res, status, payload) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

async function readBody(req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 1_000_000) throw new HttpError(413, '请求体太大')
  }
  try {
    return body ? JSON.parse(body) : {}
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON')
  }
}

// ---------------------------------------------------------------- 插件主体

export function apply(ctx) {
  const log = (message) => {
    try {
      ctx.logger?.info?.(`[music-player] ${message}`)
    } catch {
      /* ignore */
    }
  }

  /** 任务表：id -> { id, filename, state, bytes, total, path, error, at } */
  const tasks = new Map()
  /** 页面回传的最后一份诊断快照（查「点不动」这类只在真实页面出现的问题用）。 */
  let lastDiag = null

  const pruneTasks = () => {
    const done = [...tasks.values()].filter((task) => task.state !== 'downloading')
    done.sort((a, b) => a.at - b.at)
    while (done.length > 30) {
      const victim = done.shift()
      tasks.delete(victim.id)
    }
  }

  /** 取上游 JSON（带缓存）。 */
  async function upstream(type, params) {
    const key = params.toString()
    const hit = cacheGet(key)
    if (hit) return hit.text

    const target = `${UPSTREAM}?${params.toString()}`
    let response
    try {
      response = await fetch(target, {
        headers: { 'user-agent': UA, accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      })
    } catch (error) {
      throw new HttpError(502, `连不上下游 API：${error?.message || error}`)
    }
    if (!response.ok) {
      if (response.status === 429) throw new HttpError(429, '上游限流了（5 分钟 50 次），稍等再试')
      throw new HttpError(502, `上游返回 HTTP ${response.status}`)
    }
    const text = await response.text()
    try {
      JSON.parse(text)
    } catch {
      throw new HttpError(502, '上游返回的不是 JSON')
    }
    cacheSet(key, { text }, CACHE_TTL[type] ?? 120_000)
    return text
  }

  /** 落盘：一边拉一边写，任务表里累计进度。 */
  async function runDownload(task, url) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': UA } })
      if (!response.ok || !response.body) {
        throw new Error(`音频地址返回 HTTP ${response.status}`)
      }
      const total = Number(response.headers.get('content-length')) || 0
      if (total) task.total = total
      const dir = downloadDir()
      await mkdir(dir, { recursive: true })
      const finalPath = uniquePath(dir, task.filename)
      const out = createWriteStream(finalPath)
      const body = Readable.fromWeb(response.body)
      body.on('data', (chunk) => {
        task.bytes += chunk.length
      })
      await pipeline(body, out)
      task.path = finalPath
      task.state = 'done'
      task.at = Date.now()
      log(`download done ${task.filename} -> ${finalPath}`)
    } catch (error) {
      task.state = 'error'
      task.error = String(error?.message || error)
      task.at = Date.now()
      log(`download failed ${task.filename}: ${task.error}`)
    }
  }

  const installWebRoutes = (webCtx, webServerService) => {
    const webServer = webServerService || webCtx.webServer
    const route = (path, handler) =>
      webCtx.effect(() =>
        webServer.register({
          kind: 'exact',
          path: PREFIX + path,
          handler: async (req, res) => {
            try {
              await handler(req, res)
            } catch (error) {
              const status = error instanceof HttpError ? error.status : 500
              log(`route ${path} failed: ${error?.message || error}`)
              if (!res.headersSent) sendJson(res, status, { ok: false, error: String(error?.message || error) })
              else {
                try {
                  res.end()
                } catch {
                  /* ignore */
                }
              }
            }
          },
        }),
      )

    // 上游 JSON 透传
    route('/api', async (req, res) => {
      const query = new URL(req.url, 'http://127.0.0.1').searchParams
      const { type, params } = readParams(query)
      const text = await upstream(type, params)
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(text)
    })

    // 字节透传：音频播放与封面图共用。Range 头原样转发，<audio> 才能拖动进度。
    route('/proxy', async (req, res) => {
      const raw = new URL(req.url, 'http://127.0.0.1').searchParams.get('u')
      const url = assertRemoteUrl(raw)
      const controller = new AbortController()
      req.on('close', () => controller.abort())
      const headers = { 'user-agent': UA, accept: '*/*' }
      const range = req.headers.range
      if (range) headers.range = range

      let upstreamRes
      try {
        upstreamRes = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' })
      } catch (error) {
        if (controller.signal.aborted) return
        throw new HttpError(502, `取流失败：${error?.message || error}`)
      }
      if (upstreamRes.status !== 200 && upstreamRes.status !== 206) {
        throw new HttpError(502, `音频源返回 HTTP ${upstreamRes.status}`)
      }
      const outHeaders = {
        'content-type': upstreamRes.headers.get('content-type') || 'application/octet-stream',
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      }
      const length = upstreamRes.headers.get('content-length')
      if (length) outHeaders['content-length'] = length
      const contentRange = upstreamRes.headers.get('content-range')
      if (contentRange) outHeaders['content-range'] = contentRange
      const disposition = upstreamRes.headers.get('content-disposition')
      if (disposition) outHeaders['content-disposition'] = disposition

      res.writeHead(upstreamRes.status, outHeaders)
      try {
        await pipeline(Readable.fromWeb(upstreamRes.body), res)
      } catch (error) {
        if (!controller.signal.aborted) throw error
      }
    })

    // 起下载任务
    route('/download', async (req, res) => {
      if (req.method !== 'POST') throw new HttpError(405, '只支持 POST')
      const body = await readBody(req)
      const url = assertRemoteUrl(body.u)
      const filename = sanitizeFilename(body.filename)
      const task = {
        id: randomUUID().slice(0, 8),
        filename,
        state: 'downloading',
        bytes: 0,
        total: 0,
        path: '',
        error: '',
        at: Date.now(),
      }
      tasks.set(task.id, task)
      pruneTasks()
      void runDownload(task, url.href)
      sendJson(res, 200, { ok: true, task })
    })

    // 任务列表
    route('/tasks', async (req, res) => {
      const list = [...tasks.values()].sort((a, b) => b.at - a.at)
      sendJson(res, 200, { ok: true, tasks: list, dir: downloadDir() })
    })

    // 页面诊断回传：POST 存快照，GET 取。只放内存，不落盘。
    route('/diag', async (req, res) => {
      if (req.method === 'POST') {
        lastDiag = await readBody(req)
        sendJson(res, 200, { ok: true })
        return
      }
      sendJson(res, 200, { ok: true, diag: lastDiag })
    })

    // 自检：给安装后的验证用
    route('/health', async (req, res) => {
      let upstreamState = 'unknown'
      let upstreamError = ''
      const started = Date.now()
      try {
        const probe = await fetch(`${UPSTREAM}?types=search&source=netease&name=test&count=1`, {
          headers: { 'user-agent': UA },
          signal: AbortSignal.timeout(8_000),
        })
        upstreamState = probe.ok ? 'ok' : `http ${probe.status}`
      } catch (error) {
        upstreamState = 'unreachable'
        upstreamError = String(error?.message || error)
      }
      sendJson(res, 200, {
        ok: true,
        plugin: 'dsh-music-player',
        prefix: PREFIX,
        upstream: upstreamState,
        upstreamError,
        probeMs: Date.now() - started,
        downloadDir: downloadDir(),
        cached: cache.size,
        tasks: tasks.size,
      })
    })

    log(`routes registered under ${PREFIX}`)
  }

  // ⚠ 插件可能比 webServer 先激活，所以先看有没有，没有就等它（和 dsh-client-modules 同一写法）
  const existingWebServer = ctx.get('webServer')
  if (existingWebServer !== undefined) installWebRoutes(ctx, existingWebServer)
  else ctx.inject(['webServer'], (webCtx) => installWebRoutes(webCtx, webCtx.webServer))

  // 卸载时清掉未完成的临时文件（已完成的保留，那是用户的下载）
  ctx.effect(() => () => {
    for (const task of tasks.values()) {
      if (task.state === 'downloading' && task.path) {
        rm(task.path, { force: true }).catch(() => {})
      }
    }
    tasks.clear()
    cache.clear()
  })
}
