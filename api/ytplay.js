const axios = require('axios');
const crypto = require('crypto');

// Memory cache for audio stream URLs (valid 1.5 hours)
const ytCache = new Map();
const CACHE_TTL = 90 * 60 * 1000;

// Multi-source fast extractors (SaveTube high-speed MP3 CDNs)
const SAVETUBE_CDNS = [
  "cdn400.savetube.vip",
  "cdn401.savetube.vip",
  "cdn403.savetube.vip",
  "cdn405.savetube.vip"
];

async function resolveToVideoId(query) {
  if (!query) return null;
  const idMatch = [
    /youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/
  ].find(p => p.test(query))?.exec(query)?.[1] || (query.length === 11 && !query.includes(' ') ? query : null);

  if (idMatch) return idMatch;

  try {
    const payload = {
      context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240101.00.00', hl: 'id', gl: 'ID' } },
      query: query
    };
    const { data } = await axios.post('https://music.youtube.com/youtubei/v1/search?prettyPrint=false', payload, {
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000
    });
    const jsonStr = JSON.stringify(data);
    const m = jsonStr.match(/\"videoId\":\"([a-zA-Z0-9_-]{11})\"/);
    if (m && m[1]) return m[1];
  } catch(e) {
    console.warn('[EXTRACT] Failed to resolve query to video ID:', e.message);
  }
  return null;
}

async function getDownload(url) {
  const idMatch = await resolveToVideoId(url);

  if (!idMatch) {
    console.error("Invalid URL or video ID:", url);
    return null;
  }

  // Check cache first
  const cached = ytCache.get(idMatch);
  if (cached && cached.expireAt > Date.now()) {
    console.log(`[EXTRACT] Cache hit for video ID: ${idMatch}`);
    return cached.data;
  }

  const fullUrl = "https://www.youtube.com/watch?v=" + idMatch;

  // 1. Savetube CDN Extractor (Generates direct MP3 download stream with global CORS & HTTP Range support)
  async function trySavetube(cdn, customTimeout = 12000) {
    const api = axios.create({
      headers: {
        "content-type": "application/json",
        "origin": "https://yt.savetube.me",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
      },
      timeout: customTimeout
    });

    const infoResponse = await api.post(`https://${cdn}/v2/info`, { url: fullUrl });
    const encryptedData = infoResponse?.data?.data;
    if (!encryptedData) throw new Error(`No data from ${cdn}`);

    const encrypted = Buffer.from(encryptedData, "base64");
    const decipher = crypto.createDecipheriv("aes-128-cbc",
      Buffer.from("C5D58EF67A7584E4A29F6C35BBC4EB12", "hex"),
      encrypted.slice(0, 16)
    );

    const decryptedBuffer = Buffer.concat([
      decipher.update(encrypted.slice(16)),
      decipher.final()
    ]);

    const decrypted = JSON.parse(decryptedBuffer.toString());
    const downloadRes = await api.post(`https://${cdn}/download`, {
      id: idMatch,
      downloadType: "audio",
      quality: "128",
      key: decrypted.key
    });

    const audioUrl = downloadRes.data?.data?.downloadUrl || downloadRes.data?.downloadUrl;
    if (!audioUrl || !audioUrl.startsWith("http")) throw new Error(`No audio URL from ${cdn}`);

    const dur = decrypted.duration || 0;
    return {
      duration: `${Math.floor(dur / 60)}:${(dur % 60).toString().padStart(2, "0")}`,
      audio: audioUrl,
      source: `savetube:${cdn}`
    };
  }

  // Race all CDNs concurrently
  const attempts = SAVETUBE_CDNS.map(cdn => trySavetube(cdn, 12000));

  try {
    const winner = await Promise.any(attempts);
    console.log(`[EXTRACT] Winner: ${winner.source}`);
    ytCache.set(idMatch, { data: winner, expireAt: Date.now() + CACHE_TTL });
    return winner;
  } catch (err) {
    for (const cdn of SAVETUBE_CDNS) {
      try {
        const res = await trySavetube(cdn, 15000);
        if (res && res.audio) {
          console.log(`[EXTRACT] Sequential Winner: ${res.source}`);
          ytCache.set(idMatch, { data: res, expireAt: Date.now() + CACHE_TTL });
          return res;
        }
      } catch (e) {
        // Continue to next CDN candidate
      }
    }
    console.error("[EXTRACT] All extraction methods exhausted for video ID: " + idMatch);
    return null;
  }
}

module.exports = async (req, res) => {
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }
    if (req.method !== 'POST') { res.status(405).json({ status: false, message: 'Method not allowed' }); return; }

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};

    const url = (body.query || body.url || '').trim();
    if (!url) { res.status(400).json({ status: false, message: 'Parameter query wajib diisi' }); return; }

    console.log(`[EXTRACT] Starting extraction for: ${url}`);

    try {
        let audioData = await getDownload(url);

        if (audioData && audioData.audio) {
            console.log("[EXTRACT] Success");
            return res.status(200).json({
                status: true,
                result: {
                    duration: audioData.duration || null,
                    download: { audio: audioData.audio }
                }
            });
        }

        console.warn("[EXTRACT] All methods failed");
        res.status(503).json({ status: false, error: "Media extraction services are currently overloaded. Please try another track." });
    } catch (err) {
        console.warn("[EXTRACT] Extraction error:", err.message);
        res.status(500).json({ status: false, error: "Internal server error during extraction" });
    }
};
