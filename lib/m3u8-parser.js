// m3u8 解析器：支持 master（多码率）与 media 播放列表、AES-128 加密、fMP4 init 段。
// 纯函数，不依赖 DOM，便于单测。

function resolveUrl(u, base) {
  if (!u) return u;
  try { return new URL(u, base).href; } catch { return u; }
}

// 去掉 URL 的 query（仅用于猜扩展名）
function parseAttrs(line) {
  // 解析 KEY/STREAM-INF 的属性串，正确处理带引号的值（URI 里可能含逗号）
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(line))) {
    attrs[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  return attrs;
}

function isMaster(text) {
  return text.includes("#EXT-X-STREAM-INF");
}

// 解析 master，返回 variant 列表
function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      const attrs = parseAttrs(line.substring(line.indexOf(":") + 1));
      // 下一非空行是 URI
      let uri = "";
      for (let j = i + 1; j < lines.length; j++) {
        const nx = lines[j].trim();
        if (!nx || nx.startsWith("#")) continue;
        uri = nx; break;
      }
      variants.push({
        url: resolveUrl(uri, baseUrl),
        bandwidth: parseInt(attrs["BANDWIDTH"] || "0", 10) || 0,
        resolution: attrs["RESOLUTION"] || "",
        codecs: attrs["CODECS"] || "",
      });
    }
  }
  return variants;
}

// 解析 media 播放列表，返回 { segments, key, mapUri, isFmp4, totalDuration }
function parseMedia(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const segments = [];
  let key = null;       // {method, uri, iv}
  let mapUri = null;    // fMP4 init 段
  let mediaSeq = 0;
  let totalDuration = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE")) {
      mediaSeq = parseInt(line.split(":")[1], 10) || 0;
    } else if (line.startsWith("#EXT-X-MAP")) {
      const attrs = parseAttrs(line.substring(line.indexOf(":") + 1));
      if (attrs["URI"]) mapUri = resolveUrl(attrs["URI"], baseUrl);
    } else if (line.startsWith("#EXT-X-KEY")) {
      const attrs = parseAttrs(line.substring(line.indexOf(":") + 1));
      const method = attrs["METHOD"] || "NONE";
      if (method === "NONE") {
        key = null;
      } else {
        key = {
          method,
          uri: attrs["URI"] ? resolveUrl(attrs["URI"], baseUrl) : null,
          iv: attrs["IV"] || null,
        };
      }
    } else if (line.startsWith("#EXTINF")) {
      const durStr = line.substring(line.indexOf(":") + 1).split(",")[0];
      const dur = parseFloat(durStr) || 0;
      totalDuration += dur;
      let uri = "";
      for (let j = i + 1; j < lines.length; j++) {
        const nx = lines[j].trim();
        if (!nx || nx.startsWith("#")) continue;
        uri = nx; break;
      }
      segments.push({
        url: resolveUrl(uri, baseUrl),
        duration: dur,
        seq: mediaSeq + segments.length,
        key: key ? { ...key } : null,
      });
    }
  }

  return {
    segments,
    mapUri,
    isFmp4: !!mapUri,
    totalDuration,
    byterange: text.includes("#EXT-X-BYTERANGE"),
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { resolveUrl, parseAttrs, isMaster, parseMaster, parseMedia };
}
