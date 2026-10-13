// 下载面板：友好列出可下载视频，点一下拿到最终文件。用户不需要懂格式/协议。

const params = new URLSearchParams(location.search);
const tabId = params.get("tabId") ? parseInt(params.get("tabId"), 10) : null;

const ICON = { video: "🎬", hls: "📺", dash: "📡", audio: "🎵", mse: "⚡", other: "📄" };
const LABEL = { video: "视频", hls: "在线视频", dash: "在线视频(DASH)", audio: "音频", mse: "正在播放的流" };

// MSE 收敛：过滤没缓冲多少的半成品，并限制卡片数量（只留最近的）
const MIN_MSE_BYTES = 64 * 1024;
const MAX_MSE_CARDS = 6;

function fmtBytes(n) {
  if (!n) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + " " + u[i];
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

async function loadData() {
  const [res, mse, th] = await Promise.all([
    chrome.runtime.sendMessage({ cmd: "getResources", tabId }),
    chrome.runtime.sendMessage({ cmd: "getMse", tabId }),
    chrome.runtime.sendMessage({ cmd: "getThumbs", tabId }).catch(() => null),
  ]);
  return {
    resources: (res && res.resources) || [],
    mse: mse && mse.mse,
    thumbs: (th && th.thumbs) || [],
  };
}

// 从页面抓到的视频帧里挑一个"无歧义"的，用于 MSE / HLS 卡片预览。
// 有多个 video 且无法确定归属时宁可返回 null（用图标），也不张冠李戴。
function pickSharedThumb(thumbs) {
  if (!thumbs || !thumbs.length) return null;
  const usable = thumbs.filter((t) => t && t.thumb);
  if (usable.length === 1) return usable[0].thumb;
  const blobs = usable.filter((t) => (t.src || "").startsWith("blob:"));
  if (blobs.length === 1) return blobs[0].thumb;
  return null;
}

function friendlyName(r) {
  // 用页面标题做名字，用户看得懂；没有就退回到文件名
  if (r.pageTitle) return r.pageTitle;
  try {
    const p = new URL(r.url).pathname.split("/").filter(Boolean).pop();
    return decodeURIComponent(p || r.url);
  } catch { return r.url; }
}

// 去掉 query/hash 后的所在目录，用于把"同一个视频的 master + 各清晰度变体"归到一组
function dirOf(url) {
  try {
    const u = new URL(url);
    u.search = ""; u.hash = "";
    const seg = u.pathname.split("/"); seg.pop();
    return u.origin + seg.join("/");
  } catch { return url; }
}

// 抓播放列表开头判断是不是 master（含多码率）。失败当作不是，保守处理。
async function isMasterPlaylist(url) {
  try {
    const resp = await fetch(url, { credentials: "include" });
    const text = await resp.text();
    return text.indexOf("#EXT-X-STREAM-INF") !== -1;
  } catch { return false; }
}

// HLS 收敛：一个视频会请求 master + 多个清晰度变体，全列出来就是噪声。
// 规则：优先保留 master（引擎会自动选最高清），并丢弃位于已保留项目录之下的变体/重复请求。
async function collapseHls(resources) {
  const hls = resources.filter((r) => r.type === "hls");
  if (hls.length <= 1) return resources;

  await Promise.all(hls.map(async (r) => { r._master = await isMasterPlaylist(r.url); }));

  const sorted = hls.slice().sort((a, b) => {
    const m = (b._master ? 1 : 0) - (a._master ? 1 : 0); // master 优先
    if (m) return m;
    return dirOf(a.url).length - dirOf(b.url).length;    // 同级别取路径更浅的
  });

  const kept = [];
  for (const r of sorted) {
    const dir = dirOf(r.url);
    const covered = kept.some((k) => {
      const kd = dirOf(k.url);
      return dir === kd || dir.startsWith(kd + "/");
    });
    if (!covered) kept.push(r);
  }
  const keptSet = new Set(kept);
  return resources.filter((r) => r.type !== "hls" || keptSet.has(r));
}

function render() {
  const list = document.getElementById("list");
  list.innerHTML = "";
  return loadData().then(async ({ resources, mse, thumbs }) => {
    const items = [];
    const shared = pickSharedThumb(thumbs);

    // 页面信息
    const first = resources[0];
    if (first && first.pageUrl) {
      document.getElementById("page").textContent = first.pageTitle
        ? first.pageTitle + " · " + first.pageUrl
        : first.pageUrl;
    }

    // 常规资源：先折叠重复的 HLS，再去掉 other 噪声
    const collapsed = await collapseHls(resources);
    for (const r of collapsed) {
      if (r.type === "other") continue;
      items.push({ kind: "resource", r });
    }
    // MSE 捕获流：过滤半成品 + 限量（只留最近的）
    if (mse && mse.buffers) {
      let bufs = mse.buffers.filter((b) => b.bytes >= MIN_MSE_BYTES);
      if (bufs.length > MAX_MSE_CARDS) bufs = bufs.slice(-MAX_MSE_CARDS);
      for (const b of bufs) items.push({ kind: "mse", b, frameId: mse.frameId });
    }

    document.getElementById("empty").classList.toggle("hidden", items.length > 0);

    for (const it of items) {
      list.appendChild(it.kind === "resource" ? resourceCard(it.r, shared) : mseCard(it.b, it.frameId, shared));
    }
  });
}

// 缩略图：opts.img=已抓到的帧(dataURL)，opts.video=直链(用 <video> 画首帧)。
// 两者都没有就显示按类型着色的图标。任一预览加载失败自动退回图标。
function makeThumb(type, opts) {
  opts = opts || {};
  const box = el("div", "thumb " + type);
  const showIcon = () => { box.textContent = ICON[type] || ICON.other; };
  if (opts.img) {
    const im = el("img", "thumb-preview");
    im.addEventListener("error", () => { im.remove(); showIcon(); });
    im.src = opts.img;
    box.appendChild(im);
  } else if (opts.video) {
    const v = document.createElement("video");
    v.className = "thumb-preview";
    v.muted = true;
    v.playsInline = true;
    v.preload = "metadata";
    // 加载到元数据后 seek 一下，逼浏览器解码并绘制该帧
    v.addEventListener("loadedmetadata", () => {
      try { v.currentTime = Math.min(1, (v.duration || 2) * 0.1); } catch (e) {}
    });
    v.addEventListener("error", () => { v.remove(); showIcon(); });
    v.src = opts.video;
    box.appendChild(v);
  } else {
    showIcon();
  }
  return box;
}

function resourceCard(r, shared) {
  const type = r.type === "dash" ? "dash" : r.type;
  const card = el("div", "card");
  // 直链视频用 <video> 出首帧；HLS 复用页面抓到的帧；其余用图标
  const opts = type === "video" ? { video: r.url }
    : (type === "hls" && shared) ? { img: shared }
    : null;
  card.appendChild(makeThumb(type, opts));

  const info = el("div", "info");
  info.appendChild(el("div", "name", friendlyName(r)));
  const metaBits = [LABEL[type] || "视频", fmtBytes(r.size)].filter(Boolean);
  info.appendChild(el("div", "meta", metaBits.join(" · ")));
  card.appendChild(info);

  const actions = el("div", "actions");
  const btn = el("button", "dl-btn", r.type === "dash" ? "复制地址" : "下载");
  btn.addEventListener("click", () => handleResource(r, btn, info));
  actions.appendChild(btn);
  card.appendChild(actions);

  return card;
}

function mseCard(b, frameId, shared) {
  const card = el("div", "card");
  card.appendChild(makeThumb("mse", shared ? { img: shared } : null));
  const info = el("div", "info");
  info.appendChild(el("div", "name", "正在播放的流（已捕获）"));
  info.appendChild(el("div", "meta", LABEL.mse + " · " + fmtBytes(b.bytes)));
  card.appendChild(info);

  const actions = el("div", "actions");
  const btn = el("button", "dl-btn", "下载");
  btn.addEventListener("click", () => saveMse(b, frameId, btn));
  actions.appendChild(btn);
  card.appendChild(actions);
  return card;
}

function attachProgress(info) {
  const wrap = el("div");
  const bar = el("div", "progress");
  const fill = el("div");
  bar.appendChild(fill);
  const line = el("div", "status-line", "");
  wrap.append(bar, line);
  info.appendChild(wrap);
  return {
    update(done, total, bytes) {
      fill.style.width = Math.round((done / total) * 100) + "%";
      line.textContent = done + " / " + total + " · " + fmtBytes(bytes);
    },
    status(t) { line.textContent = t; },
  };
}

async function handleResource(r, btn, info) {
  if (r.type === "dash") {
    await navigator.clipboard.writeText(r.url);
    btn.textContent = "已复制";
    setTimeout(() => (btn.textContent = "复制地址"), 1500);
    return;
  }
  btn.disabled = true;
  const originalText = btn.textContent;
  let prog = null;
  const ensureProg = () => (prog || (prog = attachProgress(info)));

  try {
    if (r.type === "hls") {
      prog = attachProgress(info);
      prog.status("准备中…");
      await SniffEngine.downloadHls(r.url, {
        referer: r.pageUrl || "",
        title: r.pageTitle || friendlyName(r),
        onStatus: (t) => prog.status(t),
        onProgress: (d, tot, b) => prog.update(d, tot, b),
      });
      btn.textContent = "完成";
    } else {
      // 直链视频/音频：交给浏览器下载管理器
      btn.textContent = "下载中";
      await SniffEngine.downloadDirect(r.url);
      btn.textContent = "完成";
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = originalText;
    const p = ensureProg();
    if (e && e.message === "BYTERANGE_UNSUPPORTED") {
      await navigator.clipboard.writeText(r.url);
      p.status("该视频需借助 yt-dlp，地址已复制到剪贴板");
    } else {
      p.status("下载失败：" + (e && e.message ? e.message : e));
    }
  }
}

async function saveMse(b, frameId, btn) {
  btn.disabled = true;
  btn.textContent = "保存中";
  const ext = (b.mime || "").includes("webm") ? "webm" : "mp4";
  chrome.tabs.sendMessage(
    tabId,
    { cmd: "saveMse", index: b.index, filename: "captured-" + Date.now() + "." + ext },
    { frameId: frameId || 0 }
  );
  setTimeout(() => { btn.textContent = "已触发"; }, 800);
}

document.getElementById("refresh").addEventListener("click", render);

document.getElementById("clear").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try { await chrome.runtime.sendMessage({ cmd: "clear", tabId }); } catch (err) {}
  btn.disabled = false;
  render();
});

if (tabId == null) {
  document.getElementById("empty").classList.remove("hidden");
  document.getElementById("empty").textContent = "无法确定来源标签页，请从网页右键菜单打开。";
} else {
  render();
}
