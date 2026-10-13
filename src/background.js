// 后台：webRequest 嗅探媒体请求，按 tab 存资源表，处理消息路由。
// 资源表存于 chrome.storage.session —— MV3 service worker 会被空闲回收，
// 内存变量会丢失，storage.session 跨 SW 重启保留、关浏览器即清。

const VIDEO_EXT_RE = /\.(mp4|m4v|webm|mov|mkv|flv|ts|m4s|m3u8|mpd|mp3|m4a|aac|wav)(\?|#|$)/i;
const STREAM_MIME_RE = /^(video\/|audio\/|application\/(x-mpegurl|vnd\.apple\.mpegurl|dash\+xml|octet-stream))/i;

function classify(url, mime) {
  const u = url.toLowerCase();
  if (u.includes(".m3u8") || (mime && mime.includes("mpegurl"))) return "hls";
  if (u.includes(".mpd") || (mime && mime.includes("dash"))) return "dash";
  if (u.includes(".ts") || u.includes(".m4s")) return "segment";
  if (mime && mime.startsWith("video/")) return "video";
  if (mime && mime.startsWith("audio/")) return "audio";
  if (VIDEO_EXT_RE.test(url)) return "video";
  return "other";
}

function isMedia(url, mime) {
  if (!url || url.startsWith("data:") || url.startsWith("blob:")) return false;
  const t = classify(url, mime);
  return t === "hls" || t === "dash" || t === "video" || t === "audio" ||
    (t === "segment" && (mime || "").match(/mp2t|mpegurl|mp4/i)) ||
    (mime && STREAM_MIME_RE.test(mime) && !mime.includes("json"));
}

function getHeader(headers, name) {
  if (!headers) return "";
  const h = headers.find((x) => x.name.toLowerCase() === name);
  return h ? h.value : "";
}

function newId() {
  return "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ---- 串行化存储：读-改-写排队执行，避免并发竞争 ----
let writeChain = Promise.resolve();
function updateStore(mutator) {
  const run = async () => {
    const data = await chrome.storage.session.get(["resources", "mseState"]);
    const store = { resources: data.resources || {}, mseState: data.mseState || {} };
    await mutator(store);
    await chrome.storage.session.set(store);
    return store;
  };
  writeChain = writeChain.then(run, run).catch((e) => console.error("[sniff]", e));
  return writeChain;
}

function readStore() {
  return chrome.storage.session.get(["resources", "mseState"]).then((d) => ({
    resources: d.resources || {},
    mseState: d.mseState || {},
  }));
}

function setBadge(tabId, count) {
  chrome.action.setBadgeText({ tabId, text: count ? String(count) : "" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#e5484d" });
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const url = details.url;
    const mime = getHeader(details.responseHeaders, "content-type");
    if (!isMedia(url, mime)) return;

    const type = classify(url, mime);
    // 过滤单个 ts/m4s 分片刷屏，只保留索引和直链；分片由合并页自己抓
    if (type === "segment") return;

    const size = parseInt(getHeader(details.responseHeaders, "content-length") || "0", 10) || 0;
    const tabId = details.tabId;
    const res = { id: newId(), url, type, mime: mime || "", size, ts: Date.now() };

    // 异步补页面标题/地址，随后再写入
    chrome.tabs.get(tabId, (tab) => {
      if (!chrome.runtime.lastError && tab) {
        res.pageUrl = tab.url || "";
        res.pageTitle = tab.title || "";
      }
      updateStore((store) => {
        const list = store.resources[tabId] || (store.resources[tabId] = []);
        if (list.some((r) => r.url === url)) return;
        list.push(res);
        setBadge(tabId, list.length);
      });
    });
  },
  { urls: ["http://*/*", "https://*/*"] },
  ["responseHeaders"]
);

chrome.tabs.onRemoved.addListener((tabId) => {
  updateStore((store) => {
    delete store.resources[tabId];
    delete store.mseState[tabId];
  });
});

// 导航到新页面时清空旧资源
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    updateStore((store) => {
      store.resources[tabId] = [];
      delete store.mseState[tabId];
      setBadge(tabId, 0);
    });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.cmd === "getResources") {
    readStore().then((s) => sendResponse({ resources: s.resources[msg.tabId] || [] }));
    return true; // 异步响应
  }
  if (msg.cmd === "getMse") {
    readStore().then((s) => sendResponse({ mse: s.mseState[msg.tabId] || null }));
    return true;
  }
  if (msg.cmd === "getThumbs") {
    const tabId = msg.tabId;
    if (tabId == null) { sendResponse({ thumbs: [] }); return true; }
    // 优先用 MSE 记录的 frameId（视频常在该帧），否则主帧
    readStore().then((s) => {
      const st = s.mseState[tabId];
      const frameId = st && st.frameId != null ? st.frameId : 0;
      chrome.tabs.sendMessage(tabId, { cmd: "captureThumbs" }, { frameId }, (resp) => {
        if (chrome.runtime.lastError || !resp) { sendResponse({ thumbs: [] }); return; }
        sendResponse({ thumbs: resp.thumbs || [] });
      });
    });
    return true;
  }
  if (msg.cmd === "clear") {
    updateStore((store) => {
      store.resources[msg.tabId] = [];
      delete store.mseState[msg.tabId];
      setBadge(msg.tabId, 0);
    }).then(() => {
      // 不带 frameId = 广播到该标签页所有帧，清空页面里已累积的 MSE 缓存
      chrome.tabs.sendMessage(msg.tabId, { cmd: "resetMse" }, () => {
        void chrome.runtime.lastError; // 页面没有内容脚本时忽略
        sendResponse({ ok: true });
      });
    });
    return true;
  }
  if (msg.cmd === "mseStatus") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) return;
    const frameId = sender.frameId || 0;
    updateStore((store) => {
      store.mseState[tabId] = { frameId, buffers: msg.buffers || [] };
    }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.cmd === "addResource") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) return;
    updateStore((store) => {
      const list = store.resources[tabId] || (store.resources[tabId] = []);
      if (!list.some((r) => r.url === msg.res.url)) {
        list.push({ id: newId(), ts: Date.now(), size: 0, ...msg.res });
        setBadge(tabId, list.length);
      }
    }).then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ---- 右键菜单 + 工具栏图标：打开下载面板 ----
const MENU_ID = "vsniff-download";

chrome.runtime.onInstalled.addListener(() => {
  // 先清后建，避免扩展重载时 duplicate id 报错
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "下载此页视频",
      contexts: ["page", "video", "audio", "link"],
    });
  });
});

function openPanel(tabId) {
  const url = chrome.runtime.getURL("panel/panel.html") + (tabId != null ? "?tabId=" + tabId : "");
  chrome.tabs.create({ url });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID && tab) openPanel(tab.id);
});

chrome.action.onClicked.addListener((tab) => {
  if (tab) openPanel(tab.id);
});

