// 下载合并引擎：被 panel 复用。自动选最高码率、并发下载、AES-128 解密、裸拼、触发保存。
// 依赖 m3u8-parser.js 的全局函数：isMaster / parseMaster / parseMedia / resolveUrl。
// 用户不需要选格式/清晰度——这里全自动决策，输出一个能播的视频文件。

(function (root) {
  const CONCURRENCY = 6;
  const RETRY = 3;

  function fmtBytes(n) {
    if (!n) return "0 B";
    const u = ["B", "KB", "MB", "GB"];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(i ? 1 : 0) + " " + u[i];
  }

  function sanitize(name) {
    return (name || "").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 60) || "video";
  }

  async function fetchUrl(url, asArray) {
    let lastErr;
    for (let attempt = 0; attempt < RETRY; attempt++) {
      try {
        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return asArray ? await resp.arrayBuffer() : await resp.text();
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  const keyCache = new Map();
  async function getCryptoKey(uri) {
    if (keyCache.has(uri)) return keyCache.get(uri);
    const raw = await fetchUrl(uri, true);
    const key = await crypto.subtle.importKey("raw", raw, "AES-CBC", false, ["decrypt"]);
    keyCache.set(uri, key);
    return key;
  }

  function ivFromSeq(seq) {
    const iv = new Uint8Array(16);
    new DataView(iv.buffer).setUint32(12, seq >>> 0, false);
    return iv;
  }

  function parseIvHex(hex) {
    const c = hex.replace(/^0x/i, "").padStart(32, "0");
    const iv = new Uint8Array(16);
    for (let i = 0; i < 16; i++) iv[i] = parseInt(c.substr(i * 2, 2), 16);
    return iv;
  }

  // 自动选最高码率的 variant
  function pickBestVariant(variants) {
    return variants.slice().sort((a, b) => b.bandwidth - a.bandwidth)[0];
  }

  /**
   * 把 TS 分片数组无损转封装成 fMP4（可播的 .mp4）。
   * 依赖内置 mux.js（root.muxjs）。不支持的编码（如 H.265）或异常时返回 null，
   * 调用方据此回退到 .ts，保证用户永远拿到一个能播的文件。
   */
  function transmuxTsToMp4(tsParts) {
    const mux = root.muxjs;
    if (!mux || !mux.mp4 || typeof mux.mp4.Transmuxer !== "function") return null;
    try {
      const transmuxer = new mux.mp4.Transmuxer();
      const sections = [];
      let gotInit = false;
      transmuxer.on("data", (seg) => {
        // mux.js 属性名为 initSegment（ftyp+moov），data 为 moof+mdat 媒体段
        if (seg.initSegment && !gotInit) { sections.push(new Uint8Array(seg.initSegment)); gotInit = true; }
        if (seg.data && seg.data.byteLength) sections.push(new Uint8Array(seg.data));
      });
      for (const p of tsParts) transmuxer.push(p);
      transmuxer.flush();
      // 至少要拿到 init 段 + 一个 media 段才算成功
      if (gotInit && sections.length >= 2) return sections;
      return null;
    } catch (e) {
      return null;
    }
  }

  // 下载直链视频/音频
  function downloadDirect(url, filename) {
    return chrome.downloads.download({ url, filename: filename || undefined, saveAs: true });
  }

  /**
   * 下载并合并 HLS。全自动：master 自动选最高清，加密自动解，容器自动定。
   * opts: { referer, title, onStatus(text), onLog(text), onProgress(done,total,bytes) }
   * 返回 { ext, bytes, filename }
   */
  async function downloadHls(m3u8Url, opts) {
    opts = opts || {};
    const status = opts.onStatus || (() => {});
    const log = opts.onLog || (() => {});
    const progress = opts.onProgress || (() => {});

    status("解析播放列表…");
    let text = await fetchUrl(m3u8Url, false);
    let mediaUrl = m3u8Url;

    if (isMaster(text)) {
      const variants = parseMaster(text, m3u8Url);
      if (!variants.length) throw new Error("未找到可用码率");
      const best = pickBestVariant(variants);
      mediaUrl = best.url;
      status("已选最高清晰度 " + (best.resolution || "") + "，加载分片列表…");
      text = await fetchUrl(mediaUrl, false);
    }

    const media = parseMedia(text, mediaUrl);
    if (media.byterange) {
      throw new Error("BYTERANGE_UNSUPPORTED");
    }
    if (!media.segments.length) throw new Error("没有解析到分片");

    log("分片 " + media.segments.length + " 个 · " + (media.isFmp4 ? "fMP4→mp4" : "TS→ts") +
      (media.segments[0].key ? " · AES-128" : ""));

    let initSeg = null;
    if (media.isFmp4 && media.mapUri) {
      status("下载 init 段…");
      initSeg = new Uint8Array(await fetchUrl(media.mapUri, true));
    }

    const parts = new Array(media.segments.length);
    let done = 0, cursor = 0, totalBytes = initSeg ? initSeg.byteLength : 0;

    const worker = async () => {
      while (cursor < media.segments.length) {
        const idx = cursor++;
        const seg = media.segments[idx];
        let buf = await fetchUrl(seg.url, true);
        if (seg.key && seg.key.method === "AES-128") {
          const key = await getCryptoKey(seg.key.uri);
          const iv = seg.key.iv ? parseIvHex(seg.key.iv) : ivFromSeq(seg.seq);
          buf = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, buf);
        }
        const u8 = new Uint8Array(buf);
        parts[idx] = u8;
        totalBytes += u8.byteLength;
        progress(++done, media.segments.length, totalBytes);
      }
    };

    status("下载分片中…");
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    status("合并中…");
    let all;
    let ext;
    let mime;
    if (media.isFmp4) {
      // 源已是 fMP4：init 段 + media 段直接拼即为合法 mp4
      all = initSeg ? [initSeg, ...parts] : parts;
      ext = "mp4";
      mime = "video/mp4";
    } else {
      // 传统 TS：无损转封装成 mp4；不支持的编码（如 H.265）自动回退 .ts
      status("转封装为 MP4…");
      const mp4Sections = transmuxTsToMp4(parts);
      if (mp4Sections) {
        all = mp4Sections;
        ext = "mp4";
        mime = "video/mp4";
      } else {
        all = parts;
        ext = "ts";
        mime = "video/mp2t";
        log("转封装不可用（可能是 H.265/HEVC），已回退输出 .ts");
      }
    }
    const blob = new Blob(all, { type: mime });
    const filename = sanitize(opts.title) + "-" + Date.now() + "." + ext;

    const objectUrl = URL.createObjectURL(blob);
    await chrome.downloads.download({ url: objectUrl, filename, saveAs: true });
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);

    status("完成：" + fmtBytes(blob.size) + " · " + ext.toUpperCase());
    return { ext, bytes: blob.size, filename };
  }

  const api = { downloadHls, downloadDirect, pickBestVariant, transmuxTsToMp4, sanitize, fmtBytes, ivFromSeq, parseIvHex };
  root.SniffEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
