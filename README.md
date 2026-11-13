# dsh-music-player

DSH 插件：左侧栏音乐播放器。搜索、播放、拖动进度、调音量、上一首/下一首、按音质下载到本地。

数据来自 [GD 音乐台](https://music.gdstudio.xyz) 的公开 API（`https://music-api.gdstudio.xyz/api.php`），
资源版权归各音乐平台所有，仅供个人学习参考，请勿传播或商用。

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | 宿主半边：注册 `/dsh-music-player/*` 本地路由（API 代理 / 音频字节代理 / 下载落盘） |
| `client.js` | 浏览器半边：三个注册点 —— `sidebar.panellist` 音符图标、`main` 面板、`shell.overlay` 沉浸歌词层 |
| `cordis.patch.yml` | loader entry（id: `music-player`） |
| `locale/*.json`、`icon.svg` | 插件管理页的标题、描述与图标 |

## 界面

- **主面板**（左侧栏音符图标进入）：左边搜索 + 结果列表，右边「正在播放」卡片 ——
  大封面、随机/上一首/播放/下一首/循环、可拖进度条、码率格式、收藏（存 localStorage）、下载、音量。
  窄屏自动改成上下排布。搜索结果和播放状态都放在模块层，切走面板再回来不会丢。
- **沉浸歌词层**（卡片上点「歌词」，或 Esc 退出）：盖在面板里的全屏歌词，按 Apple Music 的做法处理 ——
  封面模糊 + 从封面取色染色的背景（慢速漂移）、当前行放大加粗带辉光、
  相邻行按距离递进虚化（`d1`~`d5`，越远越淡越模糊）、译文小一号跟在原文下；
  点任意一行可以跳到那一句；底部有「唱片 / 只歌词」布局切换、「双语」开关和「退出」
  - 为什么不用 `shell.overlay`：那个槽位**默认 click-through**，实测整层点不动（进度条、上下一首都点不了）。
    现在改成盖在 `main` 面板内部（`position:absolute`），事件一定通。
  - 前奏还没到第一句歌词时，把第一行当 active。否则没有任何行是 active，
    所有行会按「离 `-1` 的距离」递进变糊，屏幕上没有一个亮点，看起来就是"全糊了"。
  - 歌词是**行级**时间轴（API 只给 `[mm:ss.mmm]` 的 LRC，没有逐字标签），所以是"行级动画"而非逐字卡拉 OK 效果。
  - 译文 `tlyric` 和原文时间轴不是同一套、行数也不等，代码里按**时间戳最接近**配对（容差 0.7s），不是按行号硬贴。
  - 注意 `shell.overlay` 这个槽位默认 click-through，浮层自己设了 `pointer-events:auto` 才能收到点击。
  - 进度条是自绘的（20px 高的 div + pointer capture）。原来的 `<input type=range>` 只有 4px 高，
    命中区太窄，基本拖不动。
  - 品牌色底上的文字一律用 `--dsw-alias-bg-base`，**不要硬编码 `#fff`**：暗色主题里
    `--dsw-alias-brand-primary` 本身就是白色，`#fff` 会变成白底白字。


## 为什么要宿主代理

1. 上游 API **不带 CORS 头**，浏览器直接 `fetch` 会被同源策略拦掉；
2. 音频/封面 CDN 在部分网络环境下浏览器端 TLS 握手不稳定，宿主 Node 的 `fetch` 更稳；
3. 下载要落盘，只能宿主做。

## 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-music-player/api?types=search\|url\|pic\|lyric&...` | 透传上游 JSON，带 TTL 缓存（上游限流 5 分钟 50 次） |
| GET | `/dsh-music-player/proxy?u=<encoded>` | 音频/封面字节透传，转发 `Range`，拖动进度条需要 |
| POST | `/dsh-music-player/download` | `{u, filename}` 起一个落盘任务，立即返回 |
| GET | `/dsh-music-player/tasks` | 任务进度、结果路径、下载目录 |
| GET | `/dsh-music-player/health` | 自检：上游可达性、下载目录、缓存/任务数 |

`/proxy` 只放行 https 公网地址，内网/本机地址会被拒（这个路由页面能调，不能变成 SSRF 跳板）。

## 下载目录

默认 `~/Downloads/DSH音乐`（没有「下载」目录时退到 `%DSH_HOME%\music-player\downloads`）。
可用环境变量 `DSH_MUSIC_DOWNLOAD_DIR` 覆盖。

## 本地测试

两个测试都不需要浏览器，也不需要先装插件：

```bash
# 宿主半边：假 cordis ctx 直接调路由（上游可达性、搜索、参数校验、取地址、Range 取流 206、
# SSRF 防护、封面、下载落盘、文件名清洗、歌词）
node test/smoke.mjs

# 浏览器半边：jsdom + react-dom 真渲染面板，桩掉 fetch
# 覆盖 模块加载 / 两个 slot 注册 / 图标渲染 / 面板渲染 / 搜索出列表 / 点下载发 POST
cd test && npm install   # 只装测试用的 react、react-dom、jsdom（首次）
node test/panel.mjs
```

`smoke.mjs` 里的下载测试会往 `DSH_MUSIC_DOWNLOAD_DIR` 写文件（不设就是默认下载目录），跑完自动删。

## 待办 / 已知限制

- 面板文案尚未走 client locale 服务（目前硬编码中文）
- 逐字歌词做不到：API 只有行级 LRC，要做需要自己对齐/标注
- 音频采样率、位深拿不到（只有码率），要显示得在宿主侧解析音频文件头
- 评论、歌单、FM 推荐没有数据源
- 频谱可视化没做：音频走同源代理，`AnalyserNode` 技术上是可用的
