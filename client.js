/**
 * dsh-music-player —— 浏览器半边。
 *
 * 三个注册点：
 *   sidebar.panellist  id=music        左侧栏音符图标
 *   main               key=music       主面板：左边搜索列表，右边「正在播放」卡片
 *   shell.overlay      id=music-immersive  全窗口沉浸歌词层（黑胶 + 行级歌词 + 双语）
 *
 * 所有请求打到宿主半边的本地路由 /dsh-music-player/*（上游 API 没有 CORS 头）。
 * 下载由宿主落盘，这里只显示任务进度和结果路径。
 *
 * 播放器用模块级 Audio 单例：面板切走、进出沉浸模式都不会中断播放。
 */
window.__ModuleLoader__.load({
  id: 'dsh-music-player',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const BASE = '/dsh-music-player'
    const FAV_KEY = 'dsh-music-player:favorites'

    const SOURCES = [
      ['netease', '网易云'],
      ['tencent', 'QQ音乐'],
      ['kuwo', '酷我'],
      ['joox', 'JOOX'],
      ['bilibili', 'B站'],
    ]
    const QUALITIES = [
      ['128', '128K'],
      ['192', '192K'],
      ['320', '320K'],
      ['740', '无损 16bit'],
      ['999', '无损 24bit'],
    ]

    // ---------------------------------------------------------------- 小工具
    const apiJson = async (params) => {
      const res = await fetch(`${BASE}/api?${new URLSearchParams(params).toString()}`, { cache: 'no-store' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      return json
    }
    const postJson = async (path, body) => {
      const res = await fetch(BASE + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      return json
    }
    const proxyUrl = (url) => `${BASE}/proxy?u=${encodeURIComponent(url)}`
    const fmtTime = (seconds) => {
      const value = Number(seconds)
      if (!Number.isFinite(value) || value <= 0) return '0:00'
      const total = Math.floor(value)
      return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
    }
    const mb = (bytes) => {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value <= 0) return ''
      return `${(value / 1048576).toFixed(1)} MB`
    }
    const artistText = (item) =>
      Array.isArray(item?.artist) ? item.artist.join('、') : String(item?.artist || '')
    /** 上游只给码率，采样率/位深拿不到，这里按码率档位映射成可读文案。 */
    const formatText = (br, size) => {
      const value = Number(br) || 0
      const parts = []
      if (value >= 999) parts.push('FLAC · 24bit 无损')
      else if (value >= 740) parts.push('FLAC · 16bit 无损')
      else if (value > 0) parts.push(`${value} kbps`)
      const sizeText = mb(size)
      if (sizeText) parts.push(sizeText)
      return parts.join(' · ')
    }

    // ---------------------------------------------------------------- 播放器单例
    const PLAYER = typeof Audio === 'function' ? new Audio() : null
    if (PLAYER) {
      PLAYER.preload = 'auto'
      PLAYER.volume = 0.85
    }

    const playerState = {
      item: null, // 当前曲目
      index: -1, // 在 currentPlaylist 里的位置
      playing: false,
      position: 0,
      duration: 0,
      volume: 0.85,
      error: '',
      endedSeq: 0, // 自然播完 +1，面板看到就切下一首
      format: '',
      immersive: false, // 沉浸歌词层是否打开
      immersiveLayout: 'split', // split = 左图右词（Apple Music 那样）；center = 只留歌词
      accent: '', // 从封面提取的主色，给沉浸层背景染色
      seekTarget: 0, // 刚 seek 到的目标位置
      seekHold: 0, // 在这之前不要用 timeupdate 覆盖显示位置
      mediaUrl: '', // 当前音频直连地址
      mediaMode: 'direct', // direct = 直连 CDN；proxy = 退回本机代理
      shuffle: false,
      repeat: 'off', // off | all | one
      favorites: [], // [{ source, id, name, artist }]
      history: [], // 搜索记录 [{ q, source, at }]，存本地
      lyric: { status: 'idle', lines: [], error: '' },
      results: [], // 搜索结果：放模块层，切走面板再回来还在
    }
    let currentPlaylist = []
    let currentQuality = '320'
    let currentSource = 'netease'

    /** 最近的操作痕迹，随 /diag 回传：区分「没点到」和「点了但媒体没跳」。 */
    const traces = []
    const trace = (kind, data) => {
      try {
        traces.push({ kind, at: Date.now(), ...data })
        while (traces.length > 14) traces.shift()
      } catch {
        /* ignore */
      }
    }

    const subscribers = new Set()
    const notify = () => {
      for (const fn of [...subscribers]) {
        try {
          fn()
        } catch {
          /* ignore */
        }
      }
    }

    const bindPlayer = () => {
      if (!PLAYER) return
      PLAYER.addEventListener('play', () => {
        playerState.playing = true
        notify()
      })
      PLAYER.addEventListener('pause', () => {
        playerState.playing = false
        notify()
      })
      PLAYER.addEventListener('ended', () => {
        playerState.playing = false
        playerState.position = 0
        playerState.endedSeq += 1
        notify()
      })
      PLAYER.addEventListener('loadedmetadata', () => {
        playerState.duration = Number.isFinite(PLAYER.duration) ? PLAYER.duration : 0
        notify()
      })
      PLAYER.addEventListener('timeupdate', () => {
        const media = PLAYER.currentTime || 0
        const now = Date.now()
        // 刚 seek 完的 0.9 秒内，如果媒体还停在老位置（等 Range 请求回来），
        // 保持显示目标位置；否则 timeupdate 会把滑块一把拽回去，看起来就是「拖不动」。
        if (now < playerState.seekHold && Math.abs(media - playerState.seekTarget) > 2) {
          playerState.position = playerState.seekTarget
        } else {
          playerState.position = media
        }
        if (Number.isFinite(PLAYER.duration)) playerState.duration = PLAYER.duration
        notify()
      })
      PLAYER.addEventListener('error', () => {
        if (!PLAYER.getAttribute('src')) return
        // 直连 CDN 失败就退回本机代理（代理能播，只是 seekable 可能为 0）
        if (playerState.mediaMode === 'direct' && playerState.mediaUrl) {
          playerState.mediaMode = 'proxy'
          trace('media-fallback-proxy', { url: String(playerState.mediaUrl).slice(0, 60) })
          PLAYER.src = proxyUrl(playerState.mediaUrl)
          const retry = PLAYER.play()
          if (retry && typeof retry.catch === 'function') retry.catch(() => {})
          notify()
          return
        }
        playerState.error = '音频加载失败，换一首或换个音质试试'
        playerState.playing = false
        notify()
      })
    }
    bindPlayer()

    // ---------------------------------------------------------------- 收藏
    const readFavorites = () => {
      try {
        const raw = window.localStorage?.getItem(FAV_KEY)
        const list = raw ? JSON.parse(raw) : []
        return Array.isArray(list) ? list : []
      } catch {
        return []
      }
    }
    const writeFavorites = (list) => {
      try {
        window.localStorage?.setItem(FAV_KEY, JSON.stringify(list.slice(0, 300)))
      } catch {
        /* 隐私模式之类，忽略 */
      }
    }
    playerState.favorites = readFavorites()
    const favoriteKey = (item) => `${item.source}:${item.id}`
    const toggleFavorite = (item) => {
      if (!item) return
      const key = favoriteKey(item)
      const exists = playerState.favorites.some((f) => `${f.source}:${f.id}` === key)
      playerState.favorites = exists
        ? playerState.favorites.filter((f) => `${f.source}:${f.id}` !== key)
        : [...playerState.favorites, { source: item.source, id: item.id, name: item.name, artist: item.artist }]
      writeFavorites(playerState.favorites)
      notify()
    }

    // ---------------------------------------------------------------- 搜索记录
    const HISTORY_KEY = 'dsh-music-player:searches'
    const readHistory = () => {
      try {
        const raw = window.localStorage?.getItem(HISTORY_KEY)
        const list = raw ? JSON.parse(raw) : []
        return Array.isArray(list) ? list.filter((entry) => entry && entry.q).slice(0, 20) : []
      } catch {
        return []
      }
    }
    const writeHistory = (list) => {
      try {
        window.localStorage?.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 20)))
      } catch {
        /* ignore */
      }
    }
    playerState.history = readHistory()
    const pushHistory = (query, source) => {
      const q = String(query || '').trim()
      if (!q) return
      const rest = playerState.history.filter((entry) => !(entry.q === q && entry.source === source))
      playerState.history = [{ q, source, at: Date.now() }, ...rest].slice(0, 20)
      writeHistory(playerState.history)
      notify()
    }
    const clearHistory = () => {
      playerState.history = []
      writeHistory([])
      notify()
    }

    // ---------------------------------------------------------------- 歌词
    const lyricCache = new Map()

    /** 解析 LRC：[mm:ss.mmm] 行级时间轴；顺手滤掉作词/作曲这类元信息行。 */
    const parseLrc = (text) => {
      const out = []
      const meta = /^(作词|作曲|编曲|制作|监制|混音|母带|录音|和声|吉他|贝斯|键盘|弦乐|出品|发行|统筹|企划|OP|SP|词|曲)\s*[:：]/i
      for (const raw of String(text || '').split('\n')) {
        const match = raw.match(/^((?:\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\])+)(.*)$/)
        if (!match) continue
        const body = match[2].trim()
        if (!body || meta.test(body)) continue
        for (const tag of match[1].match(/\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/g) || []) {
          const parts = tag.slice(1, -1).split(':')
          const seconds = Number(parts[0]) * 60 + parseFloat(parts[1])
          if (Number.isFinite(seconds)) out.push({ time: seconds, text: body })
        }
      }
      return out.sort((a, b) => a.time - b.time)
    }

    /**
     * 把译文并到原文上。注意 tlyric 和 lyric 的时间轴不是同一套、行数也不等，
     * 所以按「时间戳最接近」配对，不能按行号硬贴。
     */
    const pairLyrics = (origin, trans) => {
      if (!trans.length) return origin.map((line) => ({ ...line, trans: '' }))
      const used = new Set()
      return origin.map((line) => {
        let best = -1
        let bestDiff = 0.7
        for (let i = 0; i < trans.length; i += 1) {
          if (used.has(i)) continue
          const diff = Math.abs(trans[i].time - line.time)
          if (diff < bestDiff) {
            bestDiff = diff
            best = i
          }
        }
        if (best >= 0) {
          used.add(best)
          return { ...line, trans: trans[best].text }
        }
        return { ...line, trans: '' }
      })
    }

    const loadLyric = async (item) => {
      const key = `${item.source}:${item.lyric_id || item.id}`
      const apply = (value) => {
        if (!playerState.item || String(playerState.item.id) !== String(item.id)) return
        playerState.lyric = value
        notify()
      }
      const hit = lyricCache.get(key)
      if (hit) return apply(hit)
      apply({ status: 'loading', lines: [], error: '' })
      try {
        const data = await apiJson({
          types: 'lyric',
          source: item.source,
          id: String(item.lyric_id || item.id),
        })
        const lines = pairLyrics(parseLrc(data?.lyric), parseLrc(data?.tlyric))
        const value = lines.length
          ? { status: 'ready', lines, error: '' }
          : { status: 'empty', lines: [], error: '' }
        lyricCache.set(key, value)
        if (lyricCache.size > 40) lyricCache.delete(lyricCache.keys().next().value)
        apply(value)
      } catch (error) {
        apply({ status: 'error', lines: [], error: String(error?.message || error) })
      }
    }

    // ---------------------------------------------------------------- 取地址 / 播放
    const urlCache = new Map()
    const resolveUrl = async (item, br) => {
      const key = `${item.source}:${item.id}:${br}`
      const hit = urlCache.get(key)
      if (hit && Date.now() - hit.at < 60_000) return hit
      const data = await apiJson({ types: 'url', source: item.source, id: String(item.id), br: String(br) })
      if (!data || !data.url) throw new Error('拿不到播放地址（这首可能没有该音质）')
      const value = { url: data.url, br: data.br, size: data.size, at: Date.now() }
      urlCache.set(key, value)
      if (urlCache.size > 60) urlCache.delete(urlCache.keys().next().value)
      return value
    }

    const pickCover = async (item) => {
      if (!item?.pic_id) return ''
      try {
        const data = await apiJson({ types: 'pic', source: item.source, id: String(item.pic_id), size: '500' })
        return data?.url || ''
      } catch {
        return ''
      }
    }

    const playItem = async (item, index, quality) => {
      if (!PLAYER) throw new Error('当前环境没有 Audio')
      playerState.error = ''
      const info = await resolveUrl(item, quality)
      const cover = await pickCover(item)
      playerState.item = { ...item, cover }
      playerState.index = index
      playerState.position = 0
      playerState.duration = 0
      playerState.format = formatText(info.br, info.size)
      playerState.accent = ''
      // 直连 CDN：经代理的流在 Chromium 里 seekable 会退化成 [0,0]（拖不动进度条），
      // CDN 自己带 CORS 头和完整 Range 语义，媒体播放不需要 CORS，所以直接用。
      playerState.mediaUrl = info.url
      playerState.mediaMode = 'direct'
      PLAYER.src = info.url
      notify()
      void extractAccent(cover)
      void loadLyric(item)
      try {
        await PLAYER.play()
      } catch {
        playerState.playing = false
        notify()
        throw new Error('播放被浏览器拦住了，点一下播放键')
      }
      notify()
    }

    /** 下一首索引：考虑随机和单曲循环。 */
    const nextIndex = (delta) => {
      const list = currentPlaylist.length ? currentPlaylist : playerState.results
      if (!list.length) return -1
      const size = list.length
      const base = playerState.index >= 0 ? playerState.index : delta > 0 ? -1 : 0
      if (delta > 0 && playerState.shuffle && size > 1) {
        let pick = base
        while (pick === base) pick = Math.floor(Math.random() * size)
        return pick
      }
      return (((base + delta) % size) + size) % size
    }

    const stepTrack = async (delta) => {
      const list = currentPlaylist.length ? currentPlaylist : playerState.results
      const index = nextIndex(delta)
      if (index < 0 || !list[index]) return
      await playItem(list[index], index, currentQuality)
    }

    const togglePlay = async () => {
      if (!PLAYER || !PLAYER.getAttribute('src')) {
        if (currentPlaylist.length) await playItem(currentPlaylist[0], 0, currentQuality)
        return
      }
      if (PLAYER.paused) {
        try {
          await PLAYER.play()
        } catch {
          throw new Error('播放被浏览器拦住了，点一下播放键')
        }
      } else {
        PLAYER.pause()
      }
    }

    const seekTo = (seconds) => {
      if (!PLAYER) return
      const value = Number(seconds)
      if (!Number.isFinite(value)) return
      const before = PLAYER.currentTime
      playerState.seekTarget = value
      playerState.seekHold = Date.now() + 900
      playerState.position = value
      notify()
      let error = ''
      let after = null
      try {
        PLAYER.currentTime = value
        after = PLAYER.currentTime
      } catch (err) {
        error = String(err?.message || err)
      }
      trace('seek', {
        want: Math.round(value),
        before: Math.round(Number(before) || 0),
        after: after === null ? null : Math.round(Number(after) || 0),
        error,
      })
      window.setTimeout(() => {
        try {
          const payload = {
            at: Date.now(),
            source: 'seek',
            want: Math.round(value),
            now: Math.round(Number(PLAYER.currentTime) || 0),
            readyState: PLAYER.readyState,
            networkState: PLAYER.networkState,
            paused: PLAYER.paused,
            mediaMode: playerState.mediaMode,
            buffered: PLAYER.buffered?.length
              ? [Math.round(PLAYER.buffered.start(0)), Math.round(PLAYER.buffered.end(0))]
              : [],
            seekable: PLAYER.seekable?.length
              ? [Math.round(PLAYER.seekable.start(0)), Math.round(PLAYER.seekable.end(0))]
              : [],
            traces: traces.slice(-14),
          }
          trace('seek+400ms', payload)
          void postJson('/diag', payload).catch(() => {})
        } catch {
          /* ignore */
        }
      }, 400)
    }

    const setVolume = (value) => {
      const clamped = Math.min(Math.max(Number(value) || 0, 0), 1)
      playerState.volume = clamped
      if (PLAYER) PLAYER.volume = clamped
      notify()
    }

    const setImmersive = (open) => {
      playerState.immersive = Boolean(open)
      notify()
    }
    const setImmersiveLayout = (layout) => {
      playerState.immersiveLayout = layout === 'center' ? 'center' : 'split'
      notify()
    }

    // ---------------------------------------------------------------- 封面取色
    /**
     * 取封面平均色给沉浸层背景染色（类 Apple Music）。封面走的是同源代理，
     * 画布不会污染，所以能直接 getImageData。失败就静默放弃，用默认色。
     */
    const accentCache = new Map()
    const extractAccent = (rawCover) => {
      if (!rawCover) return
      if (accentCache.has(rawCover)) {
        playerState.accent = accentCache.get(rawCover)
        notify()
        return
      }
      try {
        const img = new Image()
        img.onload = () => {
          try {
            const canvas = document.createElement('canvas')
            canvas.width = 16
            canvas.height = 16
            const context = canvas.getContext('2d')
            if (!context) return
            context.drawImage(img, 0, 0, 16, 16)
            const { data } = context.getImageData(0, 0, 16, 16)
            let r = 0
            let g = 0
            let b = 0
            let count = 0
            for (let i = 0; i < data.length; i += 4) {
              if (data[i + 3] < 40) continue
              r += data[i]
              g += data[i + 1]
              b += data[i + 2]
              count += 1
            }
            if (!count) return
            const lift = (sum) => Math.round(Math.min(255, (sum / count) * 1.18 + 20))
            const color = `rgba(${lift(r)},${lift(g)},${lift(b)},.9)`
            accentCache.set(rawCover, color)
            if (accentCache.size > 40) accentCache.delete(accentCache.keys().next().value)
            if (playerState.item?.cover === rawCover) {
              playerState.accent = color
              notify()
            }
          } catch {
            /* 取色失败不影响别的 */
          }
        }
        img.onerror = () => {}
        img.src = proxyUrl(rawCover)
      } catch {
        /* ignore */
      }
    }
    const toggleShuffle = () => {
      playerState.shuffle = !playerState.shuffle
      notify()
    }
    const cycleRepeat = () => {
      playerState.repeat =
        playerState.repeat === 'off' ? 'all' : playerState.repeat === 'all' ? 'one' : 'off'
      notify()
    }

    const downloadItem = async (item, quality) => {
      const info = await resolveUrl(item, quality)
      const lossless = Number(info.br) >= 740
      const artist = artistText(item)
      const ext = lossless ? 'flac' : 'mp3'
      const filename = `${artist ? `${artist} - ` : ''}${item.name}.${ext}`
      const data = await postJson('/download', { u: info.url, filename })
      return data.task
    }

    // ---------------------------------------------------------------- 侧栏图标
    function MusicIcon(props) {
      const size = props?.size || 18
      const active = Boolean(props?.active)
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: active ? 2 : 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', opacity: active ? 1 : 0.86 },
        },
        h('circle', { cx: 7.2, cy: 17.2, r: 2.7 }),
        h('circle', { cx: 17.4, cy: 15.4, r: 2.7 }),
        h('path', { d: 'M9.9 17.2V7.6l10.2-2.2v10' }),
      )
    }

    // ---------------------------------------------------------------- 样式
    const CSS = `
.mp-page{height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font:13.5px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;position:relative;container-type:inline-size}
.mp-page *{box-sizing:border-box}
.mp-head{position:relative;z-index:2;display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:14px 18px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.mp-title{font-size:15px;font-weight:650;margin:0 10px 0 0;white-space:nowrap}
.mp-select,.mp-input{height:30px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 8px;font:inherit;outline:none}
.mp-input{min-width:170px;flex:1}
.mp-input:focus,.mp-select:focus{border-color:var(--dsw-alias-brand-primary)}
.mp-btn{height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;white-space:nowrap}
.mp-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.mp-btn:disabled{opacity:.5;cursor:default}
.mp-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.mp-btn.tiny{height:24px;padding:0 8px;font-size:12px}
.mp-btn.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.mp-body{flex:1;min-height:0;display:flex;overflow:hidden}
.mp-left{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.mp-scroll{flex:1;min-height:0;overflow:auto;padding:8px 18px 16px}
.mp-hint{color:var(--dsw-alias-label-secondary);font-size:12.5px;padding:8px 2px}
.mp-hist{position:relative;z-index:1;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 18px 0;background:var(--dsw-alias-bg-base)}
.mp-hist-label{flex:none;font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.mp-hist-chip{max-width:180px;height:22px;padding:0 9px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mp-hist-chip:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.mp-hist-clear{flex:none;height:22px;padding:0 4px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;cursor:pointer;text-decoration:underline}
.mp-error{color:var(--dsw-alias-state-error-primary);font-size:12.5px;padding:6px 2px}
.mp-notice{color:var(--dsw-alias-state-success-primary);font-size:12.5px;padding:6px 2px}
.mp-list{display:flex;flex-direction:column;gap:2px}
.mp-item{display:flex;align-items:center;gap:10px;padding:7px 9px;border-radius:8px}
.mp-item:hover{background:var(--dsw-alias-bg-layer-1)}
.mp-item.active{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}
.mp-idx{width:20px;flex:none;text-align:right;color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums}
.mp-item.active .mp-idx{color:var(--dsw-alias-brand-primary)}
.mp-thumb{width:34px;height:34px;flex:none;border-radius:5px;object-fit:cover;background:var(--dsw-alias-bg-layer-2)}
.mp-meta{min-width:0;flex:1}
.mp-name{font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mp-sub{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mp-actions{display:flex;gap:6px;flex:none}
.mp-tasks{padding:6px 0 0}
.mp-task{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);padding:2px 0}
.mp-task b{font-weight:600;color:var(--dsw-alias-label-primary);font-size:12.5px}
.mp-task.done b{color:var(--dsw-alias-state-success-primary)}
.mp-task.error b{color:var(--dsw-alias-state-error-primary)}
.mp-taskname{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* ---- 右侧正在播放卡片 ---- */
.mp-cardwrap{flex:none;width:322px;overflow:auto;border-left:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);padding:18px 20px 24px}
.mp-cover{width:100%;aspect-ratio:1/1;border-radius:14px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);box-shadow:0 12px 30px rgba(0,0,0,.22);display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary)}
.mp-cover img{width:100%;height:100%;object-fit:cover;display:block}
.mp-cover .mp-note{font-size:44px;opacity:.5}
.mp-cardtitle{margin-top:16px;font-size:16.5px;font-weight:650;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.mp-cardartist{margin-top:3px;font-size:12.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.mp-ctrls{display:flex;align-items:center;justify-content:space-between;gap:4px;margin:18px 0 14px}
.mp-round{width:38px;height:38px;border-radius:50%;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;flex:none}
.mp-round:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.mp-round:disabled{opacity:.45;cursor:default}
.mp-round.play{width:54px;height:54px;background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-size:19px;box-shadow:0 8px 20px rgba(0,0,0,.22)}
.mp-round.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}

/* 自绘进度条：input[type=range] 只有 4px 高、命中区太窄，拖动很别扭。
   这里改成 20px 高的 div + pointer capture，整条带都能点/拖。 */
.mp-seek{position:relative;height:20px;width:100%;display:flex;align-items:center;cursor:pointer;touch-action:none}
.mp-seek.disabled{cursor:default;opacity:.5;pointer-events:none}
.mp-seek-track{position:relative;width:100%;height:4px;border-radius:2px;background:var(--dsw-alias-border-l2)}
.mp-seek-fill{position:absolute;left:0;top:0;height:100%;border-radius:2px;background:var(--dsw-alias-brand-primary)}
.mp-seek-knob{position:absolute;right:-6px;top:50%;width:12px;height:12px;margin-top:-6px;border-radius:50%;background:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1.5px var(--dsw-alias-bg-base);transition:transform .15s ease}
.mp-seek:hover .mp-seek-knob{transform:scale(1.18)}
.mp-times{display:flex;justify-content:space-between;font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:5px;font-variant-numeric:tabular-nums}
.mp-format{margin-top:12px;text-align:center;font-size:11.5px;letter-spacing:.02em;color:var(--dsw-alias-label-secondary)}
.mp-cardactions{display:flex;gap:6px;margin-top:14px}
.mp-cardactions .mp-btn{flex:1;padding:0 6px}
.mp-volrow{display:flex;align-items:center;gap:8px;margin-top:12px;color:var(--dsw-alias-label-secondary);font-size:11.5px}
.mp-volrow>span{flex:none;white-space:nowrap}

/* ---- 沉浸歌词层 ---- */
/* ---- 沉浸歌词层（盖在面板内，不再用 shell.overlay：那个槽位是 click-through，
   之前整层点不动就是这么来的。放在面板里事件一定通） ---- */
.mp-imm{position:absolute;inset:0;z-index:50;overflow:hidden;color:#fff;background:#08090c;display:flex;flex-direction:column;-webkit-user-select:none;user-select:none;pointer-events:auto}
.mp-imm-bg{position:absolute;inset:-12%;background-size:cover;background-position:center;filter:blur(58px) saturate(1.5) brightness(.55);animation:mp-drift 28s ease-in-out infinite alternate;pointer-events:none}
@keyframes mp-drift{from{transform:scale(1.12) translate3d(-1.6%,-1%,0)}to{transform:scale(1.24) translate3d(1.6%,1.4%,0)}}
/* 封面提取出来的主色，做一层染色（类 Apple Music 的封面取色背景） */
.mp-imm-tint{position:absolute;inset:0;background:radial-gradient(135% 115% at 50% 8%,var(--mp-accent,rgba(125,145,185,.34)),rgba(0,0,0,0) 64%);mix-blend-mode:soft-light;opacity:.95;pointer-events:none}
.mp-imm-veil{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.46),rgba(0,0,0,.14) 34%,rgba(0,0,0,.58));pointer-events:none}
.mp-imm-main{position:relative;z-index:1;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;gap:56px;padding:28px 56px 4px}
.mp-imm-left{flex:none;display:flex;flex-direction:column;align-items:center;gap:20px}
.mp-disc{width:min(28vh,215px);aspect-ratio:1/1;border-radius:50%;background:radial-gradient(circle at 50% 50%,#1c1f26 0 31%,#101218 32% 100%);display:flex;align-items:center;justify-content:center;box-shadow:0 22px 60px rgba(0,0,0,.6);animation:mp-spin 22s linear infinite}
.mp-disc.paused{animation-play-state:paused}
.mp-disc img{width:64%;height:64%;border-radius:50%;object-fit:cover;box-shadow:0 0 0 3px rgba(255,255,255,.07)}
.mp-disc .mp-note{font-size:40px;color:rgba(255,255,255,.35)}
@keyframes mp-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
.mp-imm-meta{text-align:center;max-width:min(28vh,215px)}
.mp-imm-name{font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mp-imm-artist{font-size:12.5px;color:rgba(255,255,255,.62);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 上下边缘溶解，滚远了的行自动淡出（遮罩在歌词可视区上） */
.mp-imm-lyrics{flex:1 1 auto;min-width:0;max-width:900px;height:100%;overflow:hidden;position:relative;display:flex;align-items:center}
.mp-imm-lines{width:100%;height:100%;overflow:hidden;padding:40vh 0;position:relative}
/* 默认（居中）布局：像 Apple Music 那样只留歌词 */
.mp-imm.center .mp-imm-left{display:none}
.mp-imm.center .mp-imm-main{justify-content:center;padding:24px clamp(20px,7vw,150px) 0}
.mp-imm.center .mp-imm-lyrics{flex:none;width:min(840px,100%)}

/* 行：离当前行越远越淡（只做轻微虚化，别糊到看不清） */
.mp-line{padding:9px 0;font-size:22px;line-height:1.42;font-weight:600;color:#fff;opacity:.42;
  transition:font-size .28s cubic-bezier(.22,.61,.36,1),opacity .28s ease,filter .28s ease,text-shadow .28s ease;cursor:pointer}
.mp-line.d1{opacity:.62;filter:blur(.2px)}
.mp-line.d2{opacity:.38;filter:blur(.5px)}
.mp-line.d3{opacity:.24;filter:blur(.9px)}
.mp-line.d4{opacity:.15;filter:blur(1.3px)}
.mp-line.d5{opacity:.09;filter:blur(1.7px)}
.mp-line:hover{opacity:.8}
.mp-line.active{opacity:1;font-size:clamp(26px,3.4vh,36px);font-weight:800;filter:none;
  text-shadow:0 2px 24px rgba(255,255,255,.26),0 0 60px rgba(170,205,255,.2)}
.mp-line-trans{margin-top:5px;font-size:.58em;font-weight:400;opacity:.72;letter-spacing:.01em}
.mp-line.active .mp-line-trans{opacity:.92}
.mp-imm-empty{font-size:15px;color:rgba(255,255,255,.55);padding:12px 0}
.mp-imm-bar{position:relative;z-index:2;display:flex;align-items:center;justify-content:center;gap:14px;padding:0 56px 20px}
.mp-imm-bar .mp-seek{flex:1 1 auto;max-width:420px}
.mp-imm .mp-seek-track{background:rgba(255,255,255,.22)}
.mp-imm .mp-seek-fill,.mp-imm .mp-seek-knob{background:#fff}
.mp-imm .mp-seek-knob{box-shadow:0 0 0 1.5px rgba(0,0,0,.35)}
.mp-imm-btn{height:32px;padding:0 12px;border-radius:16px;border:1px solid rgba(255,255,255,.24);background:rgba(255,255,255,.08);color:#fff;font:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap}
.mp-imm-btn:hover{background:rgba(255,255,255,.18)}
.mp-imm-btn.on{background:rgba(120,190,255,.28);border-color:rgba(120,190,255,.6)}
.mp-imm-time{font-size:11.5px;color:rgba(255,255,255,.7);font-variant-numeric:tabular-nums;min-width:38px;text-align:center}
.mp-imm-err{position:absolute;bottom:100%;left:0;right:0;text-align:center;font-size:12px;color:#ffb1b1;padding-bottom:6px;pointer-events:none}
/* ---- 窄面板：用容器查询跟「面板宽度」走，不再跟窗口宽度走 ---- */
.mp-mini{display:none;flex:none;flex-direction:column;gap:6px;padding:8px 12px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.mp-mini .mp-round{width:32px;height:32px;font-size:12px;flex:none}
.mp-mini .mp-round.play{width:38px;height:38px;font-size:15px}
.mp-mini-row{display:flex;align-items:center;gap:8px;min-width:0}
.mp-mini-cover{display:block;width:40px;height:40px;flex:none;border-radius:6px;object-fit:cover;background:var(--dsw-alias-bg-layer-2)}
.mp-mini-meta{flex:1;min-width:0}
.mp-mini-name{font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mp-mini-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mp-mini-time{flex:none;min-width:34px;text-align:right;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}

@container (max-width: 760px){
  .mp-title{display:none}
  .mp-head{gap:6px;padding:10px 12px 8px}
  .mp-select{height:30px;font-size:12.5px}
  .mp-btn{height:34px;padding:0 14px}
  .mp-actions .mp-btn.tiny{height:28px;padding:0 10px;font-size:12.5px}
  .mp-hist-chip{height:26px}
  .mp-input{order:9;flex:1 1 100%;min-width:0;height:30px}
  /* 卡片在窄面板里太占地方：换成顶部一条迷你播放条 */
  .mp-cardwrap{display:none}
  .mp-mini{display:flex}
  .mp-hist{padding:6px 12px 0}
  .mp-scroll{padding:6px 12px 14px}
  .mp-item{padding:6px 6px;gap:8px}
  .mp-idx{width:16px;font-size:11px}
  .mp-imm-main{flex-direction:column;gap:16px;padding:18px 18px 4px}
  .mp-disc{width:min(20vh,120px)}
  .mp-line{font-size:17px}
  .mp-line.active{font-size:21px}
  .mp-imm-bar{padding:0 14px 16px;gap:8px;flex-wrap:wrap}
}
`

    // ---------------------------------------------------------------- 进度条
    /**
     * 自绘拖动条。`<input type="range">` 的命中区只有 4px 高，实际很难拖。
     *
     * 关键：**不依赖 pointer 事件**。pointerdown/pointermove 在个别环境里可能收不到，
     * 所以 mouse 事件才是兜底主力；两边都监听、move/up 挂到 window 上，指针移出元素也不丢。
     * 同一坐标重复触发是幂等的，不用去重。
     */
    function SeekBar(props) {
      const { value, max, disabled, onSeek, onPreview, className } = props
      const boxRef = useRef(null)
      const dragging = useRef(false)
      const [drag, setDrag] = useState(null)
      const shown = drag === null ? value : drag
      const percent = max > 0 ? Math.min(100, Math.max(0, (Number(shown) / max) * 100)) : 0

      // window 监听只装一次，用 ref 拿最新的 max/onSeek/onPreview/disabled
      const latest = useRef({ max, onSeek, onPreview, disabled })
      latest.current = { max, onSeek, onPreview, disabled }

      // 拖动过程中**只更新显示**，松手才真正 seek 一次。
      // 以前每个 move 都设 currentTime，一秒几十次 seek，Chromium 会在目标位置附近
      // 反复冲刷解码缓冲，听感就是「拖完之后 0.1~0.2 秒被重复播放一次」。
      const pendingRef = useRef(null)
      const lastCommit = useRef(0)
      const applyAt = useRef((clientX) => {
        const box = boxRef.current?.getBoundingClientRect?.()
        if (!box || !box.width) {
          trace('seek-apply-skip', { clientX: Math.round(Number(clientX) || 0), width: box?.width ?? null })
          return
        }
        const { max: maxValue } = latest.current
        const ratio = Math.min(1, Math.max(0, (clientX - box.left) / box.width))
        const next = ratio * maxValue
        pendingRef.current = next
        trace('seek-apply', { clientX: Math.round(clientX), ratio: Number(ratio.toFixed(3)), next: Math.round(next) })
        setDrag(next)
        if (typeof latest.current.onPreview === 'function') latest.current.onPreview(next)
      }).current

      useEffect(() => {
        const move = (event) => {
          if (!dragging.current) return
          const touch = event.touches?.[0]
          const x = Number.isFinite(touch?.clientX) ? touch.clientX : Number(event.clientX)
          if (Number.isFinite(x)) applyAt(x)
        }
        const end = () => {
          if (!dragging.current) return
          dragging.current = false
          const target = pendingRef.current
          pendingRef.current = null
          setDrag(null)
          if (typeof latest.current.onPreview === 'function') latest.current.onPreview(null)
          if (target !== null && Number.isFinite(target)) {
            lastCommit.current = Date.now()
            latest.current.onSeek(target)
          }
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('mousemove', move)
        window.addEventListener('touchmove', move)
        window.addEventListener('pointerup', end)
        window.addEventListener('mouseup', end)
        window.addEventListener('touchend', end)
        window.addEventListener('pointercancel', end)
        return () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('mousemove', move)
          window.removeEventListener('touchmove', move)
          window.removeEventListener('pointerup', end)
          window.removeEventListener('mouseup', end)
          window.removeEventListener('touchend', end)
          window.removeEventListener('pointercancel', end)
        }
      }, [applyAt])

      const begin = (clientX) => {
        trace('seekbar-down', { clientX: Math.round(Number(clientX) || 0), disabled: Boolean(latest.current.disabled) })
        if (latest.current.disabled) return
        if (!Number.isFinite(Number(clientX))) return
        dragging.current = true
        pendingRef.current = null
        applyAt(Number(clientX))
      }
      const beginRef = useRef(begin)
      beginRef.current = begin

      // 原生监听兜底：不经过 React 的事件委托，避免委托链被掐断时整个控件变哑。
      // 和上面的 onPointerDown/onMouseDown 重复触发是幂等的。
      useEffect(() => {
        const node = boxRef.current
        if (!node) return undefined
        const down = (event) => {
          const touch = event.touches?.[0]
          const x = Number.isFinite(touch?.clientX) ? touch.clientX : Number(event.clientX)
          if (Number.isFinite(x)) beginRef.current(x)
        }
        node.addEventListener('pointerdown', down)
        node.addEventListener('mousedown', down)
        node.addEventListener('touchstart', down)
        return () => {
          node.removeEventListener('pointerdown', down)
          node.removeEventListener('mousedown', down)
          node.removeEventListener('touchstart', down)
        }
      }, [])

      return h(
        'div',
        {
          className: `mp-seek${disabled ? ' disabled' : ''}${className ? ` ${className}` : ''}`,
          ref: boxRef,
          onPointerDown: (event) => begin(event.clientX),
          onMouseDown: (event) => begin(event.clientX),
          onTouchStart: (event) => begin(event.touches?.[0]?.clientX),
          // 拖动起点若被别处吞掉，click 这条路仍然在：点哪儿跳哪儿
          onClick: (event) => {
            if (latest.current.disabled) return
            // 刚拖完已经 commit 过一次，这里别再来一次（重复 seek 就是卡顿来源）
            if (Date.now() - lastCommit.current < 500) return
            trace('seekbar-click', { clientX: Math.round(Number(event.clientX) || 0) })
            applyAt(Number(event.clientX))
            const target = pendingRef.current
            pendingRef.current = null
            if (typeof latest.current.onPreview === 'function') latest.current.onPreview(null)
            if (target !== null && Number.isFinite(target)) {
              lastCommit.current = Date.now()
              latest.current.onSeek(target)
            }
          },
        },
        h(
          'div',
          { className: 'mp-seek-track' },
          h(
            'div',
            { className: 'mp-seek-fill', style: { width: `${percent}%` } },
            h('div', { className: 'mp-seek-knob' }),
          ),
        ),
      )
    }

    // ---------------------------------------------------------------- 沉浸歌词层
    function Immersive() {
      const [snap, setSnap] = useState({ ...playerState })
      const [active, setActive] = useState(0)
      const [bilingual, setBilingual] = useState(true)
      const [err, setErr] = useState('')
      const [previewAt, setPreviewAt] = useState(null)
      const activeRef = useRef(null)
      const boxRef = useRef(null)
      const open = snap.immersive
      // 沉浸层里的操作出错时给个可见提示，别静默失败
      const run = (fn) => {
        setErr('')
        Promise.resolve()
          .then(fn)
          .catch((error) => setErr(String(error?.message || error)))
      }

      useEffect(() => {
        const update = () => setSnap({ ...playerState })
        subscribers.add(update)
        update()
        return () => subscribers.delete(update)
      }, [])

      // Esc 退出
      useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setImmersive(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      // 用 rAF 按 audio.currentTime 算当前行（timeupdate 只有 4Hz，切行会慢半拍）
      useEffect(() => {
        if (!open) return undefined
        let raf = 0
        let last = -1
        const tick = () => {
          const lines = playerState.lyric.lines
          const time = (PLAYER?.currentTime || 0) + 0.12
          let index = -1
          for (let i = 0; i < lines.length; i += 1) {
            if (lines[i].time <= time) index = i
            else break
          }
          // 前奏还没到第一句歌词时，把第一行当作 active：
          // 否则没有任何行是 active，所有行都会按「离 -1 的距离」递进变糊，
          // 屏幕上就没有一个亮点，看起来像全糊了。
          if (index < 0 && lines.length) index = 0
          if (index !== last) {
            last = index
            setActive(index)
          }
          raf = window.requestAnimationFrame(tick)
        }
        raf = window.requestAnimationFrame(tick)
        return () => window.cancelAnimationFrame(raf)
      }, [open])

      // 当前行对齐到可视区中间。用 getBoundingClientRect 差值，不受 offsetParent /
      // box-sizing / padding 影响；直接改 scrollTop，避免 smooth 动画被打断。
      useEffect(() => {
        const box = boxRef.current
        const node = activeRef.current
        if (!box || !node || !open) return
        const boxRect = box.getBoundingClientRect()
        const nodeRect = node.getBoundingClientRect()
        const delta = nodeRect.top + nodeRect.height / 2 - (boxRect.top + boxRect.height / 2)
        if (Math.abs(delta) < 1) return
        box.scrollTop += delta
      }, [active, snap.lyric.lines.length, open])

      // 打开时把现场信息回传给宿主 /diag：pointer-events、命中测试、滚动状态，
      // 这些只发生在真实页面里的问题，光看代码猜不出来。
      useEffect(() => {
        if (!open) return undefined
        const timer = window.setTimeout(() => {
          try {
            const box = document.querySelector('.mp-imm')
            const chain = []
            let element = box
            for (let i = 0; i < 6 && element; i += 1) {
              const style = window.getComputedStyle(element)
              chain.push(
                `${element.tagName}.${String(element.className || '').slice(0, 40)} pe=${style.pointerEvents} pos=${style.position} z=${style.zIndex}`,
              )
              element = element.parentElement
            }
            const hits = [...document.querySelectorAll('.mp-imm-bar button, .mp-imm-bar .mp-seek')].map(
              (button) => {
                const rect = button.getBoundingClientRect()
                const target =
                  typeof document.elementFromPoint === 'function'
                    ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
                    : null
                return {
                  label: String(button.textContent || button.className || '').slice(0, 8),
                  ok: target === button || button.contains(target),
                  top: target ? `${target.tagName}.${String(target.className || '').slice(0, 30)}` : 'none',
                  rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
                }
              },
            )
            const all = [...document.querySelectorAll('.mp-line')]
            const activeIndex = all.findIndex((node) => node.classList.contains('active'))
            const linesBox = box?.querySelector('.mp-imm-lines')
            postJson('/diag', {
              at: Date.now(),
              viewport: [window.innerWidth, window.innerHeight],
              activeIndex,
              activeText: activeIndex >= 0 ? String(all[activeIndex].textContent || '').slice(0, 24) : '',
              currentTime: PLAYER?.currentTime ?? null,
              duration: PLAYER?.duration ?? null,
              lineCount: playerState.lyric.lines.length,
              lyricStatus: playerState.lyric.status,
              scroll: linesBox
                ? { top: Math.round(linesBox.scrollTop), client: linesBox.clientHeight, height: linesBox.scrollHeight }
                : null,
              chain,
              hits,
              seekable: PLAYER?.seekable?.length
                ? [Math.round(PLAYER.seekable.start(0)), Math.round(PLAYER.seekable.end(0))]
                : [],
              readyState: PLAYER?.readyState ?? null,
              networkState: PLAYER?.networkState ?? null,
              buffered: PLAYER?.buffered?.length
                ? [Math.round(PLAYER.buffered.start(0)), Math.round(PLAYER.buffered.end(0))]
                : [],
              mediaMode: playerState.mediaMode,
              srcKind: String(PLAYER?.currentSrc || PLAYER?.src || '').includes('/proxy?') ? 'proxy' : 'direct',
              traces: traces.slice(-14),
            }).catch(() => {})
          } catch {
            /* 诊断失败不影响播放 */
          }
        }, 700)
        return () => window.clearTimeout(timer)
      }, [open])

      if (!open) return null

      const item = snap.item
      const cover = item?.cover ? proxyUrl(item.cover) : ''
      const lines = snap.lyric.lines
      const status = snap.lyric.status

      let body
      if (!item) body = h('div', { className: 'mp-imm-empty' }, '还没有播放歌曲 —— 先在面板里搜一首')
      else if (status === 'loading') body = h('div', { className: 'mp-imm-empty' }, '歌词加载中…')
      else if (status === 'error') body = h('div', { className: 'mp-imm-empty' }, snap.lyric.error || '歌词加载失败')
      else if (!lines.length) body = h('div', { className: 'mp-imm-empty' }, '这首歌没有歌词，享受旋律吧')
      else {
        body = lines.map((line, index) =>
          h(
            'div',
            {
              key: `${index}:${line.time}`,
              className: index === active ? 'mp-line active' : `mp-line d${Math.min(5, Math.abs(index - active))}`,
              ref: index === active ? activeRef : null,
              onClick: () => seekTo(line.time),
            },
            line.text,
            bilingual && line.trans ? h('div', { className: 'mp-line-trans' }, line.trans) : null,
          ),
        )
      }

      return h(
        'div',
        {
          className: `mp-imm${snap.immersiveLayout === 'center' ? ' center' : ''}`,
          style: { '--mp-accent': snap.accent || 'rgba(125,145,185,.34)' },
        },
        h('style', null, CSS),
        cover ? h('div', { className: 'mp-imm-bg', style: { backgroundImage: `url("${cover}")` } }) : null,
        h('div', { className: 'mp-imm-tint' }),
        h('div', { className: 'mp-imm-veil' }),
        h(
          'div',
          { className: 'mp-imm-main' },
          h(
            'div',
            { className: 'mp-imm-left' },
            h(
              'div',
              { className: snap.playing ? 'mp-disc' : 'mp-disc paused' },
              cover ? h('img', { src: cover, alt: '' }) : h('span', { className: 'mp-note' }, '♪'),
            ),
            h(
              'div',
              { className: 'mp-imm-meta' },
              h('div', { className: 'mp-imm-name' }, item?.name || '未在播放'),
              h('div', { className: 'mp-imm-artist' }, artistText(item) || '未知歌手'),
            ),
          ),
          h('div', { className: 'mp-imm-lyrics' }, h('div', { className: 'mp-imm-lines', ref: boxRef }, body)),
        ),
        h(
          'div',
          { className: 'mp-imm-bar' },
          err ? h('div', { className: 'mp-imm-err' }, err) : null,
          h('button', { className: 'mp-imm-btn', type: 'button', title: '上一首', onClick: () => run(() => stepTrack(-1)) }, '⏮'),
          h('button', {
            className: 'mp-imm-btn',
            type: 'button',
            title: snap.playing ? '暂停' : '播放',
            onClick: () => run(togglePlay),
          }, snap.playing ? '⏸' : '▶'),
          h('button', { className: 'mp-imm-btn', type: 'button', title: '下一首', onClick: () => run(() => stepTrack(1)) }, '⏭'),
          h('span', { className: 'mp-imm-time' }, fmtTime(previewAt === null ? snap.position : previewAt)),
          h(SeekBar, {
            value: snap.duration > 0 ? Math.min(snap.position, snap.duration) : 0,
            max: snap.duration,
            disabled: snap.duration <= 0,
            onSeek: seekTo,
            onPreview: setPreviewAt,
          }),
          h('span', { className: 'mp-imm-time' }, fmtTime(snap.duration)),
          h('button', {
            className: snap.immersiveLayout === 'center' ? 'mp-imm-btn on' : 'mp-imm-btn',
            type: 'button',
            title: '切换布局：左图右词 / 只留歌词',
            onClick: () => setImmersiveLayout(snap.immersiveLayout === 'center' ? 'split' : 'center'),
          }, snap.immersiveLayout === 'center' ? '只歌词' : '唱片'),
          h('button', {
            className: bilingual ? 'mp-imm-btn on' : 'mp-imm-btn',
            type: 'button',
            title: '显示 / 隐藏译文',
            onClick: () => setBilingual((value) => !value),
          }, '双语'),
          h('button', {
            className: 'mp-imm-btn',
            type: 'button',
            title: '退出沉浸模式（Esc）',
            onClick: () => setImmersive(false),
          }, '退出'),
        ),
      )
    }

    // ---------------------------------------------------------------- 窄面板迷你播放条
    /** 面板窄的时候（手机 / 拆分窗口）卡片换成顶部一条，避免竖着占掉一半高度。 */
    function MiniBar() {
      const [snap, setSnap] = useState({ ...playerState })
      const [preview, setPreview] = useState(null)
      useEffect(() => {
        const update = () => setSnap({ ...playerState })
        subscribers.add(update)
        update()
        return () => subscribers.delete(update)
      }, [])
      const item = snap.item
      if (!item) return null
      const duration = snap.duration || 0
      const position = Math.min(snap.position || 0, duration || 0)
      return h(
        'div',
        { className: 'mp-mini' },
        h(
          'div',
          { className: 'mp-mini-row' },
          item.cover
            ? h('img', { className: 'mp-mini-cover', src: proxyUrl(item.cover), alt: '' })
            : h('div', { className: 'mp-mini-cover' }),
          h(
            'div',
            { className: 'mp-mini-meta' },
            h('div', { className: 'mp-mini-name' }, item.name),
            h('div', { className: 'mp-mini-sub' }, artistText(item) || '未知歌手'),
          ),
          h('button', { className: 'mp-round', type: 'button', title: '上一首', onClick: () => void stepTrack(-1) }, '⏮'),
          h('button', {
            className: 'mp-round play',
            type: 'button',
            title: snap.playing ? '暂停' : '播放',
            onClick: () => void togglePlay().catch(() => {}),
          }, snap.playing ? '⏸' : '▶'),
          h('button', { className: 'mp-round', type: 'button', title: '下一首', onClick: () => void stepTrack(1) }, '⏭'),
          h('button', { className: 'mp-btn tiny', type: 'button', title: '全屏歌词', onClick: () => setImmersive(true) }, '歌词'),
        ),
        h(
          'div',
          { className: 'mp-mini-row' },
          h(SeekBar, {
            value: position,
            max: duration,
            disabled: duration <= 0,
            onSeek: seekTo,
            onPreview: setPreview,
          }),
          h(
            'span',
            { className: 'mp-mini-time' },
            `${fmtTime(preview === null ? position : preview)} / ${fmtTime(duration)}`,
          ),
        ),
      )
    }

    // ---------------------------------------------------------------- 主面板
    function Panel() {
      const [snap, setSnap] = useState({ ...playerState })
      const [source, setSource] = useState(currentSource)
      const [quality, setQuality] = useState(currentQuality)
      const [searching, setSearching] = useState(false)
      const [busyId, setBusyId] = useState('')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [tasks, setTasks] = useState([])
      const [downloadDir, setDownloadDir] = useState('')
      const [previewAt, setPreviewAt] = useState(null)
      const mounted = useRef(true)
      const searchRef = useRef(null)

      useEffect(() => {
        mounted.current = true
        const update = () => setSnap({ ...playerState })
        subscribers.add(update)
        update()
        return () => {
          mounted.current = false
          subscribers.delete(update)
        }
      }, [])

      useEffect(() => {
        currentQuality = quality
      }, [quality])
      useEffect(() => {
        currentSource = source
      }, [source])

      // 自然播完：单曲循环 / 随机 / 顺序
      const endedSeq = snap.endedSeq
      useEffect(() => {
        if (!endedSeq) return
        if (playerState.repeat === 'one') {
          seekTo(0)
          const playing = PLAYER?.play()
          if (playing && typeof playing.catch === 'function') playing.catch(() => {})
          return
        }
        stepTrack(1).catch((err) => setError(String(err?.message || err)))
      }, [endedSeq])

      const refreshTasks = useCallback(async () => {
        try {
          const res = await fetch(`${BASE}/tasks`, { cache: 'no-store' })
          const data = await res.json()
          if (!mounted.current) return
          setTasks(Array.isArray(data.tasks) ? data.tasks : [])
          if (data.dir) setDownloadDir(data.dir)
        } catch {
          /* 轮询失败不打扰用户 */
        }
      }, [])

      useEffect(() => {
        void refreshTasks()
        const timer = setInterval(() => void refreshTasks(), 1500)
        return () => clearInterval(timer)
      }, [refreshTasks])

      const runSearch = async (event, overrideSource) => {
        event?.preventDefault?.()
        const name = String(searchRef.current?.value || '').trim()
        const useSource = overrideSource || source
        if (!name) {
          setError('先输入歌名 / 歌手 / 专辑')
          return
        }
        setSearching(true)
        setError('')
        setNotice('')
        try {
          const data = await apiJson({ types: 'search', source: useSource, name, count: '20', pages: '1' })
          const list = Array.isArray(data) ? data : []
          if (!mounted.current) return
          // 结果放到模块层，切走面板再回来不会丢
          playerState.results = list
          currentPlaylist = list
          pushHistory(name, useSource)
          notify()
          if (!list.length) setError('没搜到，换个关键词或换个音乐源')
        } catch (err) {
          if (mounted.current) setError(String(err?.message || err))
        } finally {
          if (mounted.current) setSearching(false)
        }
      }

      const playAt = async (item, index) => {
        setError('')
        setNotice('')
        try {
          await playItem(item, index, quality)
        } catch (err) {
          setError(String(err?.message || err))
        }
      }

      const onDownload = async (item) => {
        setError('')
        setNotice('')
        setBusyId(String(item.id))
        try {
          const task = await downloadItem(item, quality)
          setNotice(`开始下载：${task?.filename || item.name}`)
          void refreshTasks()
        } catch (err) {
          setError(String(err?.message || err))
        } finally {
          if (mounted.current) setBusyId('')
        }
      }

      const onStep = async (delta) => {
        setError('')
        try {
          await stepTrack(delta)
        } catch (err) {
          setError(String(err?.message || err))
        }
      }

      const onToggle = async () => {
        setError('')
        try {
          await togglePlay()
        } catch (err) {
          setError(String(err?.message || err))
        }
      }

      const activeItem = snap.item
      const results = snap.results
      const hasAudio = Boolean(activeItem)
      const duration = snap.duration || 0
      const position = Math.min(snap.position || 0, duration || Number.MAX_SAFE_INTEGER)
      const favorite = hasAudio && snap.favorites.some((f) => `${f.source}:${f.id}` === favoriteKey(activeItem))

      const rowFor = (item, index) => {
        const active =
          activeItem && String(activeItem.id) === String(item.id) && activeItem.source === item.source
        const cover = active ? activeItem.cover : ''
        return h(
          'div',
          { key: `${item.source}:${item.id}:${index}`, className: active ? 'mp-item active' : 'mp-item' },
          h('div', { className: 'mp-idx' }, active && snap.playing ? '♪' : String(index + 1)),
          cover ? h('img', { className: 'mp-thumb', src: proxyUrl(cover), alt: '', loading: 'lazy' }) : null,
          h(
            'div',
            { className: 'mp-meta' },
            h('div', { className: 'mp-name', title: item.name }, item.name),
            h(
              'div',
              { className: 'mp-sub', title: artistText(item) },
              `${artistText(item) || '未知歌手'}${item.album ? ` · ${item.album}` : ''}`,
            ),
          ),
          h(
            'div',
            { className: 'mp-actions' },
            h('button', {
              className: 'mp-btn tiny',
              type: 'button',
              onClick: () => void playAt(item, index),
            }, active && snap.playing ? '正在播放' : '播放'),
            h('button', {
              className: 'mp-btn tiny',
              type: 'button',
              disabled: busyId === String(item.id),
              onClick: () => void onDownload(item),
            }, busyId === String(item.id) ? '解析中…' : '下载'),
          ),
        )
      }

      const taskRow = (task) => {
        const percent = task.total ? Math.min(100, Math.round((task.bytes / task.total) * 100)) : 0
        const stateText =
          task.state === 'done'
            ? '已保存'
            : task.state === 'error'
              ? task.error || '失败'
              : task.total
                ? `${mb(task.bytes)} / ${mb(task.total)} · ${percent}%`
                : mb(task.bytes)
        return h(
          'div',
          { key: task.id, className: `mp-task ${task.state}` },
          h('b', null, stateText),
          h('span', { className: 'mp-taskname', title: task.path || task.filename }, task.path || task.filename),
          task.state === 'done' && task.path
            ? h('button', {
                className: 'mp-btn tiny',
                type: 'button',
                onClick: () => {
                  void navigator.clipboard?.writeText(task.path)
                  setNotice('路径已复制')
                },
              }, '复制路径')
            : null,
        )
      }

      // ---- 右侧「正在播放」卡片 ----
      const card = h(
        'div',
        { className: 'mp-cardwrap' },
        h(
          'div',
          { className: 'mp-cover' },
          activeItem?.cover
            ? h('img', { src: proxyUrl(activeItem.cover), alt: '' })
            : h('span', { className: 'mp-note' }, '♪'),
        ),
        h('div', { className: 'mp-cardtitle' }, activeItem?.name || '未在播放'),
        h(
          'div',
          { className: 'mp-cardartist' },
          hasAudio
            ? `${artistText(activeItem) || '未知歌手'}${activeItem.album ? ` · ${activeItem.album}` : ''}`
            : '搜到歌后点「播放」',
        ),
        h(
          'div',
          { className: 'mp-ctrls' },
          h('button', {
            className: snap.shuffle ? 'mp-round on' : 'mp-round',
            type: 'button',
            title: '随机播放',
            onClick: toggleShuffle,
          }, '随机'),
          h('button', {
            className: 'mp-round',
            type: 'button',
            title: '上一首',
            disabled: !results.length,
            onClick: () => void onStep(-1),
          }, '⏮'),
          h('button', {
            className: 'mp-round play',
            type: 'button',
            title: snap.playing ? '暂停' : '播放',
            onClick: () => void onToggle(),
          }, snap.playing ? '⏸' : '▶'),
          h('button', {
            className: 'mp-round',
            type: 'button',
            title: '下一首',
            disabled: !results.length,
            onClick: () => void onStep(1),
          }, '⏭'),
          h('button', {
            className: snap.repeat === 'off' ? 'mp-round' : 'mp-round on',
            type: 'button',
            title: `循环：${snap.repeat === 'off' ? '关' : snap.repeat === 'all' ? '列表' : '单曲'}`,
            onClick: cycleRepeat,
          }, snap.repeat === 'one' ? '单曲' : '循环'),
        ),
        h(SeekBar, {
          value: position,
          max: duration,
          disabled: duration <= 0,
          onSeek: seekTo,
          onPreview: setPreviewAt,
        }),
        h(
          'div',
          { className: 'mp-times' },
          h('span', null, fmtTime(previewAt === null ? position : previewAt)),
          h('span', null, fmtTime(duration)),
        ),
        h('div', { className: 'mp-format' }, hasAudio ? snap.format || '' : ''),
        h(
          'div',
          { className: 'mp-cardactions' },
          h('button', {
            className: favorite ? 'mp-btn on' : 'mp-btn',
            type: 'button',
            disabled: !hasAudio,
            title: '收藏（存在本地）',
            onClick: () => toggleFavorite(activeItem),
          }, favorite ? '♥ 已收藏' : '♡ 收藏'),
          h('button', {
            className: 'mp-btn',
            type: 'button',
            title: '全屏沉浸歌词（Esc 退出）',
            onClick: () => setImmersive(true),
          }, '歌词'),
          h('button', {
            className: 'mp-btn',
            type: 'button',
            disabled: !hasAudio || busyId === String(activeItem?.id || ''),
            onClick: () => hasAudio && void onDownload(activeItem),
          }, '下载'),
        ),
        h(
          'div',
          { className: 'mp-volrow' },
          h('span', null, '音量'),
          h(SeekBar, { value: snap.volume, max: 1, onSeek: setVolume }),
        ),
      )

      return h(
        'div',
        { className: 'mp-page' },
        h('style', null, CSS),
        h(
          'form',
          { className: 'mp-head', onSubmit: runSearch },
          h('h2', { className: 'mp-title' }, '音乐播放器'),
          h(
            'select',
            { className: 'mp-select', value: source, onChange: (event) => setSource(event.target.value), title: '音乐源' },
            SOURCES.map(([value, label]) => h('option', { key: value, value }, label)),
          ),
          h(
            'select',
            { className: 'mp-select', value: quality, onChange: (event) => setQuality(event.target.value), title: '音质' },
            QUALITIES.map(([value, label]) => h('option', { key: value, value }, label)),
          ),
          h('input', {
            className: 'mp-input',
            ref: searchRef,
            placeholder: '搜歌名 / 歌手 / 专辑，回车搜索',
          }),
          h('button', { className: 'mp-btn primary', type: 'submit', disabled: searching }, searching ? '搜索中…' : '搜索'),
        ),
        h(MiniBar),
        h(
          'div',
          { className: 'mp-body' },
          h(
            'div',
            { className: 'mp-left' },
            snap.history.length
              ? h(
                  'div',
                  { className: 'mp-hist' },
                  h('span', { className: 'mp-hist-label' }, '最近搜索'),
                  snap.history.slice(0, 10).map((entry) =>
                    h(
                      'button',
                      {
                        key: `${entry.source}:${entry.q}`,
                        className: 'mp-hist-chip',
                        type: 'button',
                        title: `${entry.q}（${entry.source}）`,
                        onClick: () => {
                          if (searchRef.current) searchRef.current.value = entry.q
                          setSource(entry.source)
                          void runSearch(null, entry.source)
                        },
                      },
                      entry.q,
                    ),
                  ),
                  h('button', { className: 'mp-hist-clear', type: 'button', onClick: clearHistory }, '清空'),
                )
              : null,
            h(
              'div',
              { className: 'mp-scroll' },
              error ? h('div', { className: 'mp-error' }, error) : null,
              notice ? h('div', { className: 'mp-notice' }, notice) : null,
              !results.length && !error
                ? h('div', { className: 'mp-hint' }, '搜索一首歌开始吧。播放后可以拖进度条、切随机/循环，点「歌词」进全屏沉浸模式（Esc 退出）。')
                : null,
              h('div', { className: 'mp-list' }, results.map(rowFor)),
              tasks.length
                ? h(
                    'div',
                    { className: 'mp-tasks' },
                    h('div', { className: 'mp-hint' }, downloadDir ? `下载到：${downloadDir}` : '下载任务'),
                    tasks.slice(0, 6).map(taskRow),
                  )
                : null,
            ),
          ),
          card,
        ),
        h(Immersive),
      )
    }

    // ---------------------------------------------------------------- 注册
    const inject = ['slots']

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      const offIcon = slots.inject('sidebar.panellist', () =>
        slots.register(
          { name: 'sidebar.panellist', id: 'music', order: 30, label: () => '音乐播放器' },
          MusicIcon,
        ),
      )
      // 沉浸层盖在面板里（见 CSS 注释：shell.overlay 是 click-through，放那儿点不动）
      const offPanel = slots.inject('main', () =>
        slots.register({ name: 'main', key: 'music' }, Panel),
      )
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
          try {
            offIcon?.()
            offPanel?.()
          } catch {
            /* ignore */
          }
          // 插件卸载/热更新时别留一个还在响的播放器
          try {
            PLAYER?.pause()
          } catch {
            /* ignore */
          }
        })
      }
    }

    return { apply, inject }
  },
})
