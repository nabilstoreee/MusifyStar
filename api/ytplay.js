const axios = require('axios');
const crypto = require('crypto');

// Memory cache for audio stream URLs (valid 1.5 hours)
const ytCache = new Map();
const CACHE_TTL = 90 * 60 * 1000;

// Multi-source fast extractors (SaveTube verified active high-speed MP3 CDNs)
const SAVETUBE_CDNS = [
  "cdn403.savetube.vip",
  "cdn401.savetube.vip",
  "cdn405.savetube.vip",
  "cdn406.savetube.vip",
  "cdn400.savetube.vip"
];

async function resolveToVideoId(query) {
  if (!query) return null;
  const clean = String(query).trim();

  // 1. Direct Regex match for YouTube & YouTube Music URLs or direct 11-char video ID
  const directIdPatterns = [
    /(?:youtube\.com\/(?:watch\?.*v=|embed\/|shorts\/|v\/)|youtu\.be\/|music\.youtube\.com\/watch\?.*v=)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ];

  for (const pattern of directIdPatterns) {
    const match = clean.match(pattern);
    if (match && match[1]) return match[1];
  }

  // 2. YouTube Music / Remix Search API
  try {
    const payload = {
      context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240101.00.00', hl: 'id', gl: 'ID' } },
      query: clean
    };
    const { data } = await axios.post('https://music.youtube.com/youtubei/v1/search?prettyPrint=false', payload, {
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      timeout: 6000
    });
    const jsonStr = JSON.stringify(data);
    const m = jsonStr.match(/\"videoId\":\"([a-zA-Z0-9_-]{11})\"/);
    if (m && m[1]) return m[1];
  } catch(e) {}

  // 3. YouTube HTML Scrape Fallback
  try {
    const res = await axios.get(`https://www.youtube.com/results?search_query=${encodeURIComponent(clean)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 6000
    });
    const m = res.data.match(/\/watch\?v=([a-zA-Z0-9_-]{11})/);
    if (m && m[1]) return m[1];
  } catch(e) {}

  return null;
}

async function getDownload(url) {
  const idMatch = await resolveToVideoId(url);

  if (!idMatch) {
    console.error("[EXTRACT] Invalid URL or could not resolve query to video ID:", url);
    return null;
  }

  // Check cache first
  const cached = ytCache.get(idMatch);
  if (cached && cached.expireAt > Date.now()) {
    console.log(`[EXTRACT] Cache hit for video ID: ${idMatch}`);
    return cached.data;
  }

  const fullUrl = "https://www.youtube.com/watch?v=" + idMatch;

  // 1. Savetube CDN Extractor (Generates direct MP3 stream with global CORS & HTTP Range support)
  async function trySavetube(cdn, customTimeout = 7000) {
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
    
    // Try primary quality 128 then fallback to 320 or 64 if needed
    let audioUrl = null;
    for (const q of ["128", "320", "64"]) {
      try {
        const downloadRes = await api.post(`https://${cdn}/download`, {
          id: idMatch,
          downloadType: "audio",
          quality: q,
          key: decrypted.key
        });
        audioUrl = downloadRes.data?.data?.downloadUrl || downloadRes.data?.downloadUrl;
        if (audioUrl && audioUrl.startsWith("http")) break;
      } catch (errQ) {}
    }

    if (!audioUrl || !audioUrl.startsWith("http")) throw new Error(`No audio URL from ${cdn}`);

    const dur = decrypted.duration || 0;
    let durStr = '';
    if (dur >= 3600) {
      const h = Math.floor(dur / 3600);
      const m = Math.floor((dur % 3600) / 60);
      const s = dur % 60;
      durStr = `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    } else {
      durStr = `${Math.floor(dur / 60)}:${(dur % 60).toString().padStart(2, "0")}`;
    }
    return {
      duration: durStr,
      audio: audioUrl,
      source: `savetube:${cdn}`
    };
  }

  // Race all verified CDNs concurrently
  const attempts = SAVETUBE_CDNS.map(cdn => trySavetube(cdn, 7000));

  try {
    const winner = await Promise.any(attempts);
    console.log(`[EXTRACT] Winner: ${winner.source}`);
    ytCache.set(idMatch, { data: winner, expireAt: Date.now() + CACHE_TTL });
    return winner;
  } catch (err) {
    for (const cdn of SAVETUBE_CDNS) {
      try {
        const res = await trySavetube(cdn, 10000);
        if (res && res.audio) {
          console.log(`[EXTRACT] Sequential Winner: ${res.source}`);
          ytCache.set(idMatch, { data: res, expireAt: Date.now() + CACHE_TTL });
          return res;
        }
      } catch (e) {}
    }
    console.warn("[EXTRACT] Extraction temporary notice for ID:", idMatch);
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

    try {
        let audioData = await getDownload(url);

        if (audioData && audioData.audio) {
            return res.status(200).json({
                status: true,
                result: {
                    duration: audioData.duration || null,
                    download: { audio: audioData.audio }
                }
            });
        }

        res.status(503).json({ status: false, error: "Layanan audio sedang padat, silakan coba lagu lain atau ulangi kembali." });
    } catch (err) {
        res.status(500).json({ status: false, error: "Gagal memproses audio stream" });
    }
};
