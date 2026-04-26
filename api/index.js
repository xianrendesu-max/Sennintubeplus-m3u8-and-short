import express from "express";
import https from "https";
import fetch from "node-fetch";
import { Innertube } from "youtubei.js";

const app = express();
const router = express.Router();

let yt;
const CONFIG_URL = "https://raw.githubusercontent.com/siawaseok3/wakame/master/video_config.json";

// YouTube.jsの初期化（シングルトン）
async function getYouTube() {
  if (!yt) {
    yt = await Innertube.create({ 
      lang: "ja", 
      location: "JP", 
      retrieve_player: true 
    });
  }
  return yt;
}

// YouTube ID バリデーション
function validateYouTubeId(req, res, next) {
  const { id } = req.params;
  if (!/^[\w-]{11}$/.test(id)) {
    return res.status(400).json({ error: "validateYouTubeIdでエラー" });
  }
  next();
}

// 設定ファイル取得
function fetchConfigJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error("fetchConfigJsonでエラー"));
      }
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch {
          reject(new Error("fetchConfigJsonでエラー"));
        }
      });
    }).on("error", () => reject(new Error("fetchConfigJsonでエラー")));
  });
}

// ================= 新機能: Shorts検索 & m3u8 直接取得 =================

// 1. Shorts検索
router.get("/shorts/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Query 'q' is required" });

  try {
    const youtube = await getYouTube();
    const result = await youtube.search(query, { type: 'video' });

    let shortsResults = [];
    const shelf = result.results.find(item => item.type === 'ReelShelf');
    
    // ReelShelf（Shorts枠）から抽出
    if (shelf && shelf.items) {
      shortsResults = shelf.items.map(v => ({
        id: v.id,
        title: v.title?.toString() || "無題",
        author: v.author?.name || "不明",
        thumbnails: v.thumbnails,
        m3u8ApiUrl: `https://${req.headers.host}/api/shorts/m3u8/${v.id}`
      }));
    }

    // 通常動画の中から60秒以下をShortsとして抽出
    const normalShorts = result.videos
      .filter(v => v.duration?.seconds <= 60)
      .map(v => ({
        id: v.id,
        title: v.title.text,
        author: v.author.name,
        thumbnails: v.thumbnails,
        m3u8ApiUrl: `https://${req.headers.host}/api/shorts/m3u8/${v.id}`
      }));

    const combined = [...new Map([...shortsResults, ...normalShorts].map(v => [v.id, v])).values()];
    res.json({ success: true, results: combined });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. m3u8 URL 直接抽出
router.get("/shorts/m3u8/:id", validateYouTubeId, async (req, res) => {
  const { id } = req.params;
  try {
    const youtube = await getYouTube();
    const info = await youtube.getInfo(id);
    
    const hlsUrl = info.streaming_data?.hls_manifest_url || null;
    
    if (!hlsUrl) {
      return res.status(404).json({ error: "m3u8 URLが見つかりませんでした。" });
    }

    res.json({
      id: id,
      title: info.basic_info.title,
      m3u8: hlsUrl,
      proxy_m3u8: `https://proxy-siawaseok.duckdns.org/proxy/m3u8?url=${encodeURIComponent(hlsUrl)}`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================= 既存機能 (維持) =================

// type1
router.get("/:id", validateYouTubeId, async (req, res) => {
  const { id } = req.params;
  try {
    const config = await fetchConfigJson(CONFIG_URL);
    const params = config.params || "";
    res.json({ url: `https://www.youtubeeducation.com/embed/${id}${params}` });
  } catch {
    res.status(500).json({ error: "type1でエラー" });
  }
});

// type2
router.get("/:id/type2", validateYouTubeId, async (req, res) => {
  const { id } = req.params;
  // 注意: Vercel環境では 127.0.0.1 へのリクエストは失敗するため、適切な外部URLへの書き換えを推奨
  const apiUrl = `http://127.0.0.1:3006/api/streams/${id}`;

  const parseHeight = (format) => {
    if (typeof format.height === "number") return format.height;
    const match = /x(\d+)/.exec(format.resolution || "");
    return match ? parseInt(match) : null;
  };

  const selectUrlLocal = (urls) => {
    if (!urls?.length) return null;
    const jaUrl = urls.find((u) => decodeURIComponent(u).includes("lang=ja"));
    return jaUrl || urls;
  };

  try {
    const response = await fetch(apiUrl);
    if (!response.ok) throw new Error(`local API取得エラー: ${response.status}`);

    const data = await response.json();
    const formats = Array.isArray(data.formats) ? data.formats : [];

    const videourl = {};
    const m3u8 = {};

    const audioUrls = formats.filter((f) => f.acodec !== "none" && f.vcodec === "none").map((f) => f.url);
    const audioOnlyUrl = selectUrlLocal(audioUrls);

    const extPriority = ["webm", "mp4", "av1"];
    const formatsByHeight = {};
    for (const f of formats) {
      const height = parseHeight(f);
      if (!height || f.vcodec === "none" || !f.url) continue;
      const label = `${height}p`;
      if (!formatsByHeight[label]) formatsByHeight[label] = [];
      formatsByHeight[label].push(f);
    }

    for (const [label, list] of Object.entries(formatsByHeight)) {
      const m3u8List = list.filter((f) => f.url.includes(".m3u8"));
      if (m3u8List.length > 0) {
        m3u8[label] = { url: { url: selectUrlLocal(m3u8List.map((f) => f.url)) } };
      }

      const normalList = list
        .filter((f) => !f.url.includes(".m3u8"))
        .sort((a, b) => extPriority.indexOf(a.ext || "") - extPriority.indexOf(b.ext || ""));

      if (normalList.length > 0) {
        videourl[label] = {
          video: { url: selectUrlLocal([normalList.url]) },
          audio: { url: audioOnlyUrl },
        };
      }
    }
    res.json({ videourl, m3u8 });
  } catch (e) {
    res.status(500).json({ error: "type2でエラー" });
  }
});

// download
router.get("/download/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const response = await fetch(`http://127.0.0.1:3006/api/streams/${id}`);
    if (!response.ok) return res.status(response.status).json({ error: "Failed to fetch stream data" });

    const data = await response.json();
    if (!data.formats || !Array.isArray(data.formats)) return res.status(500).json({ error: "Invalid format data" });

    const result = { "audio only": [], "video only": [], "audio&video": [], "m3u8 raw": [], "m3u8 proxy": [] };

    for (const f of data.formats) {
      if (!f.url) continue;
      const url = f.url.toLowerCase();
      if (url.includes("lang=") && !url.includes("lang=ja")) continue;

      if (url.endsWith(".m3u8")) {
        const m3u8Data = { url: f.url, resolution: f.resolution, vcodec: f.vcodec, acodec: f.acodec };
        result["m3u8 raw"].push(m3u8Data);
        result["m3u8 proxy"].push({
          ...m3u8Data,
          url: `https://proxy-siawaseok.duckdns.org/proxy/m3u8?url=${encodeURIComponent(f.url)}`,
        });
        continue;
      }

      if (f.resolution === "audio only" || f.vcodec === "none") {
        result["audio only"].push(f);
      } else if (f.acodec === "none") {
        result["video only"].push(f);
      } else {
        result["audio&video"].push(f);
      }
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// アプリケーションへマウント
app.use("/api", router);

export default app;
