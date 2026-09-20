const axios = require('axios');
const crypto = require('crypto');

// Memory cache for audio stream URLs (valid 1.5 hours)
const ytCache = new Map();
const CACHE_TTL = 90 * 60 * 1000;

async function getDownload(url) {
  const idMatch = [
    /youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/
  ].find(p => p.test(url))?.exec(url)?.[1] || (url.length === 11 ? url : null);

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
  const cdns = ["cdn405.savetube.vip", "cdn403.savetube.vip", "cdn401.savetube.vip"];

  // Race all CDNs in parallel instead of looping sequentially.
  // Sequential (3 cdn x 2 attempts x 25s) could take up to 150s. Racing them
  // means total wall time is bounded by the fastest responding CDN.
  const PER_CDN_TIMEOUT = 25000;
  const controller = new AbortController();

  async function tryCdn(cdn) {
    const api = axios.create({
      headers: {
        "content-type": "application/json",
        "origin": "https://yt.savetube.me",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
      },
      timeout: PER_CDN_TIMEOUT,
      signal: controller.signal
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
    if (!audioUrl) throw new Error(`No audio URL from ${cdn}`);

    return {
      duration: `${Math.floor(decrypted.duration / 60)}:${(decrypted.duration % 60).toString().padStart(2, "0")}`,
      audio: audioUrl,
      cdn
    };
  }

  try {
    const result = await Promise.any(cdns.map(cdn =>
      tryCdn(cdn).catch(err => {
        const isCanceled = axios.isCancel(err) ||
          err.name === 'CanceledError' ||
          err.code === 'ERR_CANCELED' ||
          err.message === 'canceled' ||
          controller.signal.aborted;

        if (!isCanceled) {
          console.warn(`[EXTRACT] ${cdn} attempt failed: ${err.message}`);
        }
        throw err;
      })
    ));

    // Winner found, stop the losing in-flight requests so they don't
    // keep the function/connections alive uselessly.
    controller.abort();

    console.log(`[EXTRACT] Winner: ${result.cdn}`);
    ytCache.set(idMatch, { data: result, expireAt: Date.now() + CACHE_TTL });
    return result;
  } catch (aggregateErr) {
    const realErrors = aggregateErr?.errors?.filter(e =>
      !axios.isCancel(e) &&
      e.name !== 'CanceledError' &&
      e.code !== 'ERR_CANCELED' &&
      e.message !== 'canceled'
    ) || [];

    if (realErrors.length > 0) {
      console.warn("[EXTRACT] All CDNs failed:", realErrors.map(e => e.message).join(" | "));
    }
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

    // Maintenance Mode check: block playback requests for non-admin clients when maintenance is ON
    try {
        const maintenanceModule = require('./maintenance.js');
        const adminAuth = require('./admin-auth.js');
        const token = req.headers['x-admin-token'] || req.headers.authorization;
        const cleanToken = token ? token.replace(/^Bearer\s+/i, '').trim() : '';
        const verifyFn = adminAuth.isValidToken || adminAuth.verifyToken;
        const isAdmin = verifyFn ? verifyFn(cleanToken) : false;

        if (maintenanceModule.isMaintenanceActive() && !isAdmin) {
            const mConfig = maintenanceModule.getMaintenanceConfig();
            return res.status(503).json({
                status: false,
                maintenance: true,
                title: mConfig.title,
                message: mConfig.message,
                estimatedEndTime: mConfig.estimatedEndTime,
                error: 'Server pemutaran musik sedang dalam mode pemeliharaan (maintenance).'
            });
        }
    } catch (mErr) {}

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
