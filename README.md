# 视频嗅探下载器（自用）

一个 Chrome MV3 扩展，嗅探网页中的视频 / m3u8 / MSE 流并下载合并。除内置 mux.js（TS→MP4 转封装）外无其他第三方依赖，核心逻辑纯原生 API + WebCrypto。

## 能做什么

你不需要懂格式、不需要选清晰度——右键、点视频、拿到文件，全自动。**输出统一为 `.mp4`**（QuickTime / 各播放器通吃）。

- **直链视频**（mp4/webm 等，如 Telegram Web）：一键下载。
- **HLS 流**（m3u8，如 X、B 站网页版、多数视频站）：自动选最高清晰度，AES-128 自动解密，并发下载分片后合并；传统 TS 流用内置 mux.js **无损转封装成 `.mp4`**（仅当遇到 H.265 等 mux.js 不支持的编码时才回退 `.ts`）。
- **MSE / blob 流**：hook 播放器的 `SourceBuffer.appendBuffer`，把喂给 `<video>` 的二进制块接住另存（本就是 mp4）。
- **DASH（mpd）**：识别并一键复制地址，交给 yt-dlp（未内置合并）。

## 安装

1. 打开 Chrome，地址栏输入 `chrome://extensions`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择本文件夹
4. 工具栏出现图标即安装成功（建议固定到工具栏）

> 需要 Chrome 111+（用到了 content script 的 `world: "MAIN"`）。

## 使用

1. 打开有视频的网页，**让视频真正开始播放几秒**（很多流媒体只在播放时才发请求）。
2. **在网页上右键 → 选「下载此页视频」**（或点工具栏图标），会打开一个下载面板。
3. 面板用页面标题友好地列出可下载的视频，**点你想下载那个的「下载」按钮**即可：
   - 直链视频 → 浏览器直接弹出保存框。
   - 在线视频（HLS）→ 卡片内显示进度条，自动合并后保存，全程无需选清晰度/格式。
   - 正在播放的流（MSE 捕获）→ 点「下载」保存已捕获的数据。
   - DASH → 点「复制地址」，交给 yt-dlp。
4. 右上角「刷新」重新扫描；「清空」丢弃当前列表（含页面已累积的 MSE 缓存）后重扫。切换页面会自动清空记录。

> **信息流站点（如 X）**：时间线会自动播放你滑过的每个视频，每个都产生一套播放列表和 MSE 捕获，列表可能变长。面板已做收敛（同一视频的 master/清晰度变体折叠成一条、过滤未缓冲完的半成品捕获并限量）。想精确定位某个视频：滑到它、让它播放，点「清空」再「刷新」，列表就只剩它。

## 合并策略说明

不打包 ffmpeg，按容器自动决定输出，**默认统一出 `.mp4`**：
- **fMP4（有 EXT-X-MAP）**：init 段 + media 段直接拼接即为合法 mp4。
- **TS 分片**：用内置 mux.js **无损转封装**成 fragmented MP4（`ftyp+moov+[moof+mdat]…`），输出 `.mp4`。不重编码、不掉画质，只是换容器。
- **AES-128**：密钥就在 m3u8 的 `EXT-X-KEY` 里，下载后用 WebCrypto 解密，再走上面的拼接/转封装。IV 缺省时按分片序号生成。
- **自动回退**：仅当 TS 用的是 mux.js 不支持的编码（如 H.265/HEVC）时，回退输出裸拼的 `.ts`（VLC/IINA/mpv 可放），保证你永远拿到一个能播的文件。

## 已知限制

- **DRM（Widevine/FairPlay）内容抓不到** —— 解密在浏览器受保护模块内完成，任何插件都拿不到明文。Netflix、X 的部分会员专享内容属此类。这是法律红线，本工具也不尝试。
- **H.265/HEVC 的 TS 流**：mux.js 不支持该编码转封装，会回退成 `.ts`（非 mp4）。这类流较少见；要 mp4 可用本机 ffmpeg 二次转封装。
- **EXT-X-BYTERANGE** 列表暂不支持，面板会提示改用 yt-dlp 并自动复制地址。
- 部分 CDN 校验 `Referer`，扩展页 fetch 无法伪造该头，可能下载失败；这类情况面板会复制地址，交给本机 `yt-dlp`（它能带 referer）。
- MSE 捕获是把播放器已解密的媒体块存盘，音视频若分离在不同 SourceBuffer，可能需要再用 ffmpeg 合并。

## yt-dlp 兜底

遇到本插件搞不定的（DASH、BYTERANGE、Referer 校验、HEVC 转 mp4），复制地址后：

```bash
yt-dlp "粘贴的m3u8或页面地址"
```

## 目录结构

```
manifest.json          MV3 配置（右键菜单 + 工具栏入口）
src/background.js      webRequest 嗅探 + storage.session 资源表 + 右键菜单/面板入口 + 消息路由
src/mse-hook.js        MAIN world，hook appendBuffer 捕获 MSE 流；并从页面 <video> 抓帧做预览图
src/relay.js           ISOLATED world，MAIN 与后台之间的消息桥
lib/m3u8-parser.js     m3u8 解析器（master/media、AES-128、fMP4、相对 URL）
lib/engine.js          下载合并引擎（自动选最高清、并发下载、解密、TS→MP4 转封装、保存）
lib/mux.min.js         mux.js 7.1.0（Apache-2.0，TS→fMP4 无损转封装）
panel/                 下载面板 UI（右键/图标打开，友好列出视频，带首帧预览，一键下载）
```


## 自用边界

仅供下载你本就能免费观看、且非 DRM 保护的内容，自用留存。请遵守各平台服务条款；绕过 DRM 或付费墙在多数司法辖区违法，本工具不涉及。
