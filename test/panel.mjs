/**
 * 浏览器半边的无头渲染测试：没有浏览器也能验证 UI 真的能渲染、能交互。
 *
 *   node test/panel.mjs
 *
 * 做法：
 *   1. jsdom 造 window/document（吞掉 jsdom 没实现的 media 报错）；
 *   2. 伪造 window.__ModuleLoader__，执行 client.js 的 factory（react 由测试提供）；
 *   3. 假 slots 调 apply()，确认三个注册点都在：sidebar.panellist / main / shell.overlay；
 *   4. 真渲染：
 *      - 侧栏图标 → svg
 *      - 面板 → 搜索出列表 → 点播放 → 右侧卡片显示曲目/格式/歌词行
 *      - 沉浸层 → 点「歌词」后出现，双语可见，Esc 关闭
 *      - 点「下载」→ 发出 POST /download
 */
import { readFileSync } from 'node:fs'
import { JSDOM, VirtualConsole } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

const CLIENT_PATH = new URL('../client.js', import.meta.url)
const source = readFileSync(CLIENT_PATH, 'utf8')

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures += 1
}

// ---------- jsdom 环境（media 的 "not implemented" 不用刷屏） ----------
const virtualConsole = new VirtualConsole()
virtualConsole.on('jsdomError', () => {})
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://127.0.0.1:61063/',
  pretendToBeVisual: true,
  virtualConsole,
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
globalThis.HTMLElement = window.HTMLElement
globalThis.HTMLInputElement = window.HTMLInputElement
globalThis.Event = window.Event
// 记录模块里 `new Audio()` 出来的那个播放器，后面伪造 duration 来测进度条
const audioInstances = []
const RealAudio = window.Audio
window.Audio = function PatchedAudio(...args) {
  const element = new RealAudio(...args)
  audioInstances.push(element)
  return element
}
window.Audio.prototype = RealAudio.prototype
globalThis.Audio = window.Audio
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// ---------- fetch 桩 ----------
const requests = []
const jsonResponse = (data) => ({ ok: true, status: 200, json: async () => data })
globalThis.fetch = async (url, init = {}) => {
  const target = String(url)
  requests.push({ url: target, method: init.method || 'GET', body: init.body })
  if (target.includes('/tasks'))
    return jsonResponse({
      ok: true,
      dir: 'C:/Users/test/Downloads/DSH音乐',
      tasks: [{ id: 't1', filename: '已完成.mp3', state: 'done', bytes: 2048, total: 2048, path: 'C:/dl/已完成.mp3', error: '', at: 1 }],
    })
  if (target.includes('types=search'))
    return jsonResponse([
      { id: '1', name: '屋顶', artist: ['周杰伦', '温岚'], album: '男女情歌对唱', pic_id: 'p1', source: 'netease', lyric_id: '1' },
      { id: '2', name: '布拉格广场', artist: ['蔡依林'], album: '看我72变', pic_id: 'p2', source: 'netease', lyric_id: '2' },
    ])
  if (target.includes('types=url')) return jsonResponse({ url: 'https://m801.music.126.net/a.mp3', br: 320, size: 9550125 })
  if (target.includes('types=pic')) return jsonResponse({ url: 'https://p2.music.126.net/a.jpg' })
  if (target.includes('types=lyric'))
    return jsonResponse({
      lyric:
        '[00:00.000] 作词 : 测试\n[00:01.000]第一行歌词\n[00:05.000]第二行歌词\n[00:09.000]第三行歌词\n' +
        '[00:13.000]第四行歌词\n[00:17.000]第五行歌词\n[00:21.000]第六行歌词',
      // 译文时间轴和原文不完全一致（真实数据就是这样），要按时间戳配对
      tlyric:
        '[00:01.012]First line\n[00:05.025]Second line\n[00:09.030]Third line\n' +
        '[00:13.030]Fourth line\n[00:17.030]Fifth line\n[00:21.030]Sixth line',
    })
  if (target.includes('/download'))
    return jsonResponse({ ok: true, task: { id: 't2', filename: '周杰伦、温岚 - 屋顶.mp3', state: 'downloading' } })
  return jsonResponse({})
}

// ---------- 载入 client.js ----------
let definition = null
window.__ModuleLoader__ = { load: (def) => { definition = def } }
new Function('window', 'require', source)(window, (name) => {
  if (name === 'react') return React
  throw new Error(`client.js 只应该 require react，实际 require 了 ${name}`)
})

check('模块已加载', Boolean(definition))
check('模块 id 与包名一致', definition?.id === 'dsh-music-player', definition?.id)

const exported = definition.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})
check('导出了 apply', typeof exported.apply === 'function')

// ---------- 假 slots ----------
const registrations = []
const fakeSlots = {
  inject: (_slot, callback) => callback(),
  register: (options, component) => {
    registrations.push({ options, component })
    return () => {}
  },
}
exported.apply({
  get: (name) => (name === 'slots' ? fakeSlots : undefined),
  effect: (factory) => {
    factory()
    return () => {}
  },
})

const iconReg = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
const panelReg = registrations.find((entry) => entry.options.name === 'main')
check('注册了 sidebar.panellist', Boolean(iconReg), `id=${iconReg?.options.id} order=${iconReg?.options.order}`)
check('sidebar id = music', iconReg?.options.id === 'music')
check('sidebar 标签可求值', typeof iconReg?.options.label === 'function' && iconReg.options.label() === '音乐播放器')
check('注册了 main 面板', panelReg?.options.key === 'music')
// 沉浸层不再注册到 shell.overlay（那个槽位 click-through，会整层点不动），改盖在面板里
check('只注册两个槽位（不再用 shell.overlay）', registrations.length === 2, `实际 ${registrations.length} 个`)
check('没有注册 shell.overlay', !registrations.some((entry) => entry.options.name === 'shell.overlay'))

// ---------- 渲染三件套 ----------
const mk = () => {
  const el = window.document.createElement('div')
  window.document.body.appendChild(el)
  return { el, root: createRoot(el) }
}
const iconBox = mk()
const panelBox = mk()
await act(async () => iconBox.root.render(React.createElement(iconReg.component, { size: 18, active: true })))
check('图标渲染出 svg', Boolean(iconBox.el.querySelector('svg')))
await act(async () => panelBox.root.render(React.createElement(panelReg.component)))

const panel = panelBox.el
// 沉浸层现在渲染在面板内部，所以这里直接复用面板容器
const overlay = panel
const ptext = () => panel.textContent || ''
const otext = () => panel.textContent || ''

check('面板渲染出标题', ptext().includes('音乐播放器'))
check('有搜索输入框', Boolean(panel.querySelector('input.mp-input')))
check('有音乐源 / 音质下拉', panel.querySelectorAll('select.mp-select').length === 2)
// p1 回归：品牌色底上的文字用 bg-base 令牌，不能再硬编码 #fff（暗色下品牌色就是白，会白底白字）
{
  const css = panel.querySelector('style')?.textContent || ''
  check('主按钮文字用 bg-base 令牌', /\.mp-btn\.primary\{[^}]*color:var\(--dsw-alias-bg-base\)/.test(css))
  check('播放按钮文字用 bg-base 令牌', /\.mp-round\.play\{[^}]*color:var\(--dsw-alias-bg-base\)/.test(css))
  check('没有把 #fff 硬编码在品牌色底按钮上', !/\.mp-btn\.primary\{[^}]*#fff/.test(css) && !/\.mp-round\.play\{[^}]*#fff/.test(css))
}
check('进度条是自绘 div（不是 input[type=range]）', Boolean(panel.querySelector('.mp-cardwrap .mp-seek')) && !panel.querySelector('.mp-cardwrap input[type=range]'))
check('卡片显示未在播放', panel.querySelector('.mp-cardtitle')?.textContent === '未在播放')
check('渲染出下载任务（轮询）', ptext().includes('已完成.mp3'))
check('沉浸层默认不渲染', overlay.querySelector('.mp-imm') === null)

// ---------- 搜索 ----------
{
  panel.querySelector('input.mp-input').value = '周杰伦'
  panel.querySelector('form.mp-head').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  const rows = panel.querySelectorAll('.mp-item')
  check('搜索结果渲染成行', rows.length === 2, `${rows.length} 行`)
  check('行里有播放 / 下载按钮', panel.querySelectorAll('.mp-item .mp-btn').length === 4)
}

// ---------- 搜索记录（本地） ----------
{
  check('搜索后出现搜索记录', Boolean(panel.querySelector('.mp-hist-chip')))
  check(
    '记录内容是刚搜的词',
    (panel.querySelector('.mp-hist-chip')?.textContent || '') === '周杰伦',
    panel.querySelector('.mp-hist-chip')?.textContent,
  )
  const before = requests.filter((r) => r.url.includes('types=search')).length
  await act(async () => {
    panel.querySelector('.mp-hist-chip').dispatchEvent(new window.Event('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  const after = requests.filter((r) => r.url.includes('types=search')).length
  check('点搜索记录会重新搜索', after > before, `${before} → ${after}`)
  check(
    '重复搜同一个词不会重复记录',
    panel.querySelectorAll('.mp-hist-chip').length === 1,
    `${panel.querySelectorAll('.mp-hist-chip').length} 条`,
  )
}

// ---------- 点播放 → 卡片 + 歌词 ----------
{
  const playButton = [...panel.querySelectorAll('.mp-item .mp-btn')].find((b) => b.textContent === '播放')
  await act(async () => {
    playButton.dispatchEvent(new window.Event('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 120))
  })
  check('卡片换成点播的曲目', panel.querySelector('.mp-cardtitle')?.textContent === '屋顶')
  check('卡片显示歌手', (panel.querySelector('.mp-cardartist')?.textContent || '').includes('周杰伦'))
  check('卡片显示格式（码率）', (panel.querySelector('.mp-format')?.textContent || '').includes('320 kbps'), panel.querySelector('.mp-format')?.textContent)
  check('请求了歌词', requests.some((r) => r.url.includes('types=lyric')))
  check('封面图走代理', Boolean(panel.querySelector('.mp-cover img')?.getAttribute('src')?.startsWith('/dsh-music-player/proxy?u=')))
}

// ---------- 进度条可拖动（p2 回归） ----------
{
  const player = audioInstances[0]
  check('拿到了模块里的播放器实例', Boolean(player))
  Object.defineProperty(player, 'duration', { configurable: true, value: 212 })
  await act(async () => {
    player.dispatchEvent(new window.Event('loadedmetadata'))
  })
  const seek = panel.querySelector('.mp-cardwrap .mp-seek')
  check('时长到位后进度条可用', Boolean(seek) && !seek.classList.contains('disabled'))
  seek.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 20, right: 200, bottom: 20, x: 0, y: 0 })
  const pointer = (type, x) => new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: 10 })
  await act(async () => {
    seek.dispatchEvent(pointer('pointerdown', 100))
  })
  check('按下进度条一半 → 跳到 1:46', panel.querySelectorAll('.mp-times span')[0]?.textContent === '1:46', `显示 ${panel.querySelectorAll('.mp-times span')[0]?.textContent}`)
  await act(async () => {
    seek.dispatchEvent(pointer('pointermove', 200))
    seek.dispatchEvent(pointer('pointerup', 200))
  })
  check('拖到末尾 → 3:32', panel.querySelectorAll('.mp-times span')[0]?.textContent === '3:32', `显示 ${panel.querySelectorAll('.mp-times span')[0]?.textContent}`)

  // 鼠标兜底路径：不依赖 pointer 事件也要能拖到 0:53
  await act(async () => {
    seek.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, clientX: 50, clientY: 10 }))
  })
  check('鼠标按下也能跳（不依赖 pointer 事件）', panel.querySelectorAll('.mp-times span')[0]?.textContent === '0:53', `显示 ${panel.querySelectorAll('.mp-times span')[0]?.textContent}`)
  await act(async () => {
    window.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }))
  })
}

// ---------- 收藏 ----------
{
  const fav = [...panel.querySelectorAll('.mp-cardactions .mp-btn')].find((b) => b.textContent.includes('收藏'))
  await act(async () => fav.dispatchEvent(new window.Event('click', { bubbles: true })))
  check('收藏状态切换', fav.textContent.includes('已收藏'), fav.textContent)
}

// ---------- 沉浸歌词层 ----------
{
  // 给播放器一个假时钟，让 rAF 能算出「当前行」（jsdom 不会真的播放）
  const player = audioInstances[0]
  let fakeClock = 0.2 // 先停在前奏：还没有任何一句歌词到点
  Object.defineProperty(player, 'currentTime', { configurable: true, get: () => fakeClock })

  const lyricButton = [...panel.querySelectorAll('.mp-cardactions .mp-btn')].find((b) => b.textContent === '歌词')
  await act(async () => {
    lyricButton.dispatchEvent(new window.Event('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 80))
  })
  check('点「歌词」打开沉浸层', Boolean(overlay.querySelector('.mp-imm')))
  // 回归：前奏阶段（没有一句到点）也必须有高亮行，否则全屏会变成「全都糊」
  check(
    '前奏阶段也有 active 行（不会全糊）',
    Boolean(overlay.querySelector('.mp-line.active')),
    overlay.querySelector('.mp-line.active')?.textContent?.slice(0, 16),
  )
  fakeClock = 5.2
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  const lines = overlay.querySelectorAll('.mp-line')
  check('歌词按行渲染（元信息行已滤掉）', lines.length === 6, `${lines.length} 行`)
  check('双语译文可见', otext().includes('First line'), otext().slice(0, 60).replace(/\s+/g, ' '))
  check('有旋转黑胶', Boolean(overlay.querySelector('.mp-disc')))
  // p4 回归：右上角 × 会和窗口自带的关闭按钮重叠，改成底部「退出」
  check('沉浸层没有右上角 ×', overlay.querySelector('.mp-imm-close') === null)
  check('沉浸层底部有「退出」', [...overlay.querySelectorAll('.mp-imm-btn')].some((b) => b.textContent === '退出'))
  check('沉浸层进度条也是自绘的', Boolean(overlay.querySelector('.mp-seek')))

  // ---- 类 Apple Music 的歌词处理 ----
  check('当前行带 active 类', Boolean(overlay.querySelector('.mp-line.active')), overlay.querySelector('.mp-line.active')?.textContent?.slice(0, 20))
  check('相邻行按距离带模糊类', Boolean(overlay.querySelector('.mp-line.d1')))
  check('远离的行级别更高', Array.from(overlay.querySelectorAll('.mp-line')).some((n) => /d[2-5]/.test(n.className)))
  check('背景有封面取色染色层', Boolean(overlay.querySelector('.mp-imm-tint')))
  {
    const layoutBtn = [...overlay.querySelectorAll('.mp-imm-btn')].find((b) => b.textContent === '唱片')
    check('有布局切换按钮（默认左图右词）', Boolean(layoutBtn))
    await act(async () => layoutBtn.dispatchEvent(new window.Event('click', { bubbles: true })))
    check('切到「只歌词」居中布局', overlay.querySelector('.mp-imm.center') !== null)
  }

  const bi = [...overlay.querySelectorAll('.mp-imm-btn')].find((b) => b.textContent === '双语')
  await act(async () => bi.dispatchEvent(new window.Event('click', { bubbles: true })))
  check('关闭双语后译文隐藏', !otext().includes('First line'))

  // Esc 退出
  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }))
  })
  check('Esc 关闭沉浸层', overlay.querySelector('.mp-imm') === null)
}

// ---------- 点下载 ----------
{
  const downloadButton = [...panel.querySelectorAll('.mp-item .mp-btn')].find((b) => b.textContent === '下载')
  await act(async () => {
    downloadButton.dispatchEvent(new window.Event('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 100))
  })
  const post = requests.find((request) => request.method === 'POST' && request.url.includes('/download'))
  check('下载走 POST /download', Boolean(post))
  if (post) {
    const body = JSON.parse(post.body)
    check('请求体带音频地址', typeof body.u === 'string' && body.u.startsWith('https://'))
    check('请求体带清洗后的文件名', body.filename === '周杰伦、温岚 - 屋顶.mp3', body.filename)
  }
  check('界面提示开始下载', ptext().includes('开始下载'))
}

// ---------- p3 回归：面板卸载再挂载，搜索结果还在 ----------
{
  await act(async () => {
    panelBox.root.unmount()
  })
  panelBox.root = createRoot(panelBox.el)
  await act(async () => panelBox.root.render(React.createElement(panelReg.component)))
  const rows = panelBox.el.querySelectorAll('.mp-item')
  check('重新挂载后保留搜索结果', rows.length === 2, `${rows.length} 行`)
  check('重新挂载后卡片仍是刚才那首', panelBox.el.querySelector('.mp-cardtitle')?.textContent === '屋顶')
}

await act(async () => {
  iconBox.root.unmount()
  panelBox.root.unmount()
})
console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
dom.window.close()
process.exit(failures === 0 ? 0 : 1)
