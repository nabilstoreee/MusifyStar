const fs = require('fs');
const path = require('path');
const adminAuth = require('./admin-auth.js');
const storage = require('./storage.js');

const VERSION_FILE = '.app_version.json';

const DEFAULT_CONFIG = {
    version: 'v1.0.0',
    releaseName: 'MusifyStar Official',
    description: 'Nikmati Streaming Musik Dengan Lirik',
    updatedAt: new Date().toISOString()
};

async function getStoredVersionAsync() {
    const parsed = await storage.readDataAsync(VERSION_FILE, DEFAULT_CONFIG);
    if (parsed && parsed.version) {
        return {
            version: String(parsed.version).trim(),
            releaseName: parsed.releaseName || 'MusifyStar Official',
            description: parsed.description || 'Nikmati Streaming Musik Dengan Lirik',
            updatedAt: parsed.updatedAt || new Date().toISOString()
        };
    }
    return DEFAULT_CONFIG;
}

function getStoredVersionSync() {
    const parsed = storage.readData(VERSION_FILE, DEFAULT_CONFIG);
    if (parsed && parsed.version) {
        return {
            version: String(parsed.version).trim(),
            releaseName: parsed.releaseName || 'MusifyStar Official',
            description: parsed.description || 'Nikmati Streaming Musik Dengan Lirik',
            updatedAt: parsed.updatedAt || new Date().toISOString()
        };
    }
    return DEFAULT_CONFIG;
}

async function saveVersionAsync(config) {
    return await storage.writeDataAsync(VERSION_FILE, config);
}

module.exports = async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET') {
        const config = await getStoredVersionAsync();
        return res.json({
            status: true,
            version: config.version,
            releaseName: config.releaseName,
            description: config.description,
            updatedAt: config.updatedAt
        });
    }

    if (req.method === 'POST') {
        const token = req.headers['x-admin-token'] || req.query.token;
        if (!token || !adminAuth.isValidToken(token)) {
            return res.status(401).json({
                status: false,
                message: 'Akses ditolak: Token admin tidak valid atau kedaluwarsa'
            });
        }

        const { version, releaseName, description } = req.body || {};
        if (!version || typeof version !== 'string' || !version.trim()) {
            return res.status(400).json({
                status: false,
                message: 'Versi aplikasi tidak boleh kosong'
            });
        }

        const newConfig = {
            version: version.trim(),
            releaseName: (releaseName && typeof releaseName === 'string') ? releaseName.trim() : 'MusifyStar Official',
            description: (description && typeof description === 'string') ? description.trim() : 'Nikmati Streaming Musik Dengan Lirik',
            updatedAt: new Date().toISOString()
        };

        const success = await saveVersionAsync(newConfig);
        if (!success) {
            return res.status(500).json({
                status: false,
                message: 'Gagal memperbarui konfigurasi versi'
            });
        }

        return res.json({
            status: true,
            message: 'Informasi versi aplikasi berhasil diperbarui!',
            version: newConfig.version,
            releaseName: newConfig.releaseName,
            description: newConfig.description,
            updatedAt: newConfig.updatedAt
        });
    }

    return res.status(405).json({ status: false, message: 'Method Not Allowed' });
};

module.exports.getStoredVersion = getStoredVersionSync;
module.exports.getStoredVersionAsync = getStoredVersionAsync;
