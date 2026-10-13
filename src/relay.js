// ISOLATED world：在 MAIN world hook 与后台之间转发消息。
(function () {
  // MAIN -> background：MSE 捕获状态
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__vsniff !== "status") return;
    chrome.runtime.sendMessage({ cmd: "mseStatus", buffers: d.buffers }).catch(() => {});
  });

  // background/panel -> MAIN：保存 buffer，或抓取视频帧预览
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.cmd === "saveMse") {
      window.postMessage({ __vsniff: "save", index: msg.index, filename: msg.filename }, "*");
      return;
    }
    if (msg.cmd === "resetMse") {
      window.postMessage({ __vsniff: "reset" }, "*");
      return;
    }
    if (msg.cmd === "captureThumbs") {
      const reqId = Math.random().toString(36).slice(2);
      let done = false;
      const onMsg = (ev) => {
        if (ev.source !== window) return;
        const d = ev.data;
        if (!d || d.__vsniff !== "thumbsResult" || d.reqId !== reqId) return;
        if (done) return;
        done = true;
        window.removeEventListener("message", onMsg);
        sendResponse({ thumbs: d.thumbs || [] });
      };
      window.addEventListener("message", onMsg);
      window.postMessage({ __vsniff: "thumbs", reqId }, "*");
      // 超时兜底：页面没有可抓的 video 时也要回话，别让通道悬挂
      setTimeout(() => {
        if (done) return;
        done = true;
        window.removeEventListener("message", onMsg);
        sendResponse({ thumbs: [] });
      }, 1200);
      return true; // 异步响应
    }
  });
})();
