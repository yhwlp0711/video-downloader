// MAIN world：代理 SourceBuffer.appendBuffer，累积播放器喂入的媒体二进制。
// 对付 blob: / MSE 流（如 X、部分 HLS.js 站点）。数据留在页面上下文，
// 收到保存指令时就地拼成 Blob 触发下载，避免跨上下文传大体积数据。
(function () {
  if (window.__vsniffHooked) return;
  window.__vsniffHooked = true;

  // 每个 SourceBuffer 一份缓存：{ mime, chunks: Uint8Array[], bytes }
  // 用 let：收到 reset 指令时整体换新，丢弃此前累积（如刷时间线滑过的一堆视频）
  let buffers = new WeakMap();
  let allBuffers = [];

  function ensureBuf(sb, mime) {
    let b = buffers.get(sb);
    if (!b) {
      b = { mime: mime || "", chunks: [], bytes: 0 };
      buffers.set(sb, b);
      allBuffers.push(b);
    }
    if (mime && !b.mime) b.mime = mime;
    return b;
  }

  const origAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = origAddSourceBuffer.call(this, mime);
    ensureBuf(sb, mime);
    return sb;
  };

  const origAppend = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    try {
      let view = null;
      if (data instanceof ArrayBuffer) view = new Uint8Array(data);
      else if (ArrayBuffer.isView(data)) view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (view && view.byteLength) {
        // 拷贝一份，防止底层复用/转移原 buffer
        const copy = new Uint8Array(view.byteLength);
        copy.set(view);
        const b = ensureBuf(this, this.__mime);
        b.chunks.push(copy);
        b.bytes += copy.byteLength;
        notify();
      }
    } catch (e) {
      // 忽略，绝不影响正常播放
    }
    return origAppend.call(this, data);
  };

  // 节流上报状态到 relay
  let notifyTimer = null;
  function notify() {
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      const summary = allBuffers.map((b, i) => ({ index: i, mime: b.mime, bytes: b.bytes }));
      window.postMessage({ __vsniff: "status", buffers: summary }, "*");
    }, 400);
  }

  // 收到指令：保存 buffer，或抓取页面 <video> 当前帧做预览图
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || !d.__vsniff) return;

    if (d.__vsniff === "save") {
      const b = allBuffers[d.index];
      if (!b || !b.chunks.length) return;
      const blob = new Blob(b.chunks, { type: b.mime || "video/mp4" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = d.filename || ("captured-" + Date.now() + ".mp4");
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return;
    }

    if (d.__vsniff === "reset") {
      buffers = new WeakMap();
      allBuffers = [];
      window.postMessage({ __vsniff: "status", buffers: [] }, "*");
      return;
    }

    if (d.__vsniff === "thumbs") {
      // 遍历页面上的 <video>，把当前帧画到 canvas 取 dataURL。
      // blob:/同源视频不会被跨域污染，能拿到帧；跨域直链会抛异常，跳过即可
      //（那类由面板用 <video> 元素自己预览）。
      const out = [];
      const vids = document.querySelectorAll("video");
      for (const v of vids) {
        try {
          if (!v.videoWidth || !v.videoHeight) continue;
          const scale = Math.min(1, 200 / v.videoWidth);
          const c = document.createElement("canvas");
          c.width = Math.max(1, Math.round(v.videoWidth * scale));
          c.height = Math.max(1, Math.round(v.videoHeight * scale));
          c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
          const thumb = c.toDataURL("image/jpeg", 0.7); // 被污染则抛错
          out.push({ src: v.currentSrc || v.src || "", thumb });
        } catch (e) {
          // 跨域污染或尚未解码，忽略这个 video
        }
      }
      window.postMessage({ __vsniff: "thumbsResult", reqId: d.reqId, thumbs: out }, "*");
    }
  });
})();
