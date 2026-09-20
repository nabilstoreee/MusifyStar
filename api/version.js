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

function getStoredVersion() {
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

function saveVersion(config) {
    return storage.writeData(VERSION_FILE, config);
}

module.exports = async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET') {
        const config = getStoredVersion();
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

        const { version, releaseName, description } = req.body;
        if (!version || typeof version !== 'string' || !version.trim()) {
            return res.status(400).json({
                status: false,
                message: 'Versi aplikasi tidak boleh kosong'
            });
        }

        let cleanVersion = version.trim();
        if (!cleanVersion.startsWith('v') && !cleanVersion.startsWith('V') && /^[0-9]/.test(cleanVersion)) {
            cleanVersion = 'v' + cleanVersion;
        }

        const newConfig = {
            version: cleanVersion,
            releaseName: (releaseName && typeof releaseName === 'string') ? releaseName.trim() : 'MusifyStar Official',
            description: (description && typeof description === 'string') ? description.trim() : 'Nikmati Streaming Musik Dengan Lirik',
            updatedAt: new Date().toISOString()
        };

        const saved = saveVersion(newConfig);
        if (saved) {
            return res.json({
                status: true,
                message: `Versi aplikasi berhasil diperbarui menjadi ${cleanVersion}`,
                config: newConfig
            });
        } else {
            return res.status(500).json({
                status: false,
                message: 'Gagal menyimpan versi ke sistem penyimpanan'
            });
        }
    }

    return res.status(405).json({ status: false, message: 'Method not allowed' });
};
