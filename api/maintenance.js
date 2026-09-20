const fs = require('fs');
const path = require('path');
const adminAuth = require('./admin-auth.js');

const MAINTENANCE_FILE = path.join(__dirname, '..', '.maintenance_config.json');

const DEFAULT_CONFIG = {
    enabled: false,
    title: 'Pemeliharaan Sistem Musik',
    message: 'Sistem saat ini sedang dalam proses peningkatan server besar. Pemutaran lagu dihentikan sementara agar update berjalan optimal.',
    estimatedEndTime: '',
    allowAdminBypass: true,
    updatedAt: new Date().toISOString()
};

function getMaintenanceConfig() {
    try {
        if (fs.existsSync(MAINTENANCE_FILE)) {
            const raw = fs.readFileSync(MAINTENANCE_FILE, 'utf8');
            const data = JSON.parse(raw);
            if (data && typeof data === 'object') {
                return {
                    enabled: Boolean(data.enabled),
                    title: typeof data.title === 'string' && data.title ? data.title : DEFAULT_CONFIG.title,
                    message: typeof data.message === 'string' && data.message ? data.message : DEFAULT_CONFIG.message,
                    estimatedEndTime: typeof data.estimatedEndTime === 'string' ? data.estimatedEndTime : '',
                    allowAdminBypass: data.allowAdminBypass !== false,
                    updatedAt: data.updatedAt || new Date().toISOString()
                };
            }
        }
    } catch (e) {
        console.error('Error reading maintenance config:', e.message);
    }
    return { ...DEFAULT_CONFIG };
}

function saveMaintenanceConfig(config) {
    const payload = {
        enabled: Boolean(config.enabled),
        title: (config.title || DEFAULT_CONFIG.title).trim(),
        message: (config.message || DEFAULT_CONFIG.message).trim(),
        estimatedEndTime: (config.estimatedEndTime || '').trim(),
        allowAdminBypass: config.allowAdminBypass !== false,
        updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(MAINTENANCE_FILE, JSON.stringify(payload, null, 2), 'utf8');
    return payload;
}

function isMaintenanceActive() {
    const config = getMaintenanceConfig();
    return Boolean(config && config.enabled);
}

module.exports = function (req, res) {
    res.setHeader('Content-Type', 'application/json');

    const method = req.method.toUpperCase();

    // GET /api/maintenance - Public check for all clients/devices
    if (method === 'GET') {
        const config = getMaintenanceConfig();
        return res.json({
            status: true,
            maintenance: config.enabled,
            ...config
        });
    }

    // POST /api/maintenance - Admin only toggle
    if (method === 'POST') {
        const token = req.headers['x-admin-token'] || req.headers.authorization;
        const cleanToken = token ? token.replace(/^Bearer\s+/i, '').trim() : '';

        const verifyFn = adminAuth.isValidToken || adminAuth.verifyToken;
        if (!verifyFn || !verifyFn(cleanToken)) {
            return res.status(401).json({
                status: false,
                message: 'Akses ditolak: Hanya administrator yang dapat mengubah status mode pemeliharaan.'
            });
        }

        let body = req.body;
        if (typeof body === 'string') {
            try { body = JSON.parse(body); } catch (e) { body = {}; }
        }
        body = body || {};

        try {
            const updated = saveMaintenanceConfig({
                enabled: body.enabled !== undefined ? Boolean(body.enabled) : false,
                title: body.title,
                message: body.message,
                estimatedEndTime: body.estimatedEndTime,
                allowAdminBypass: body.allowAdminBypass
            });

            return res.json({
                status: true,
                success: true,
                message: updated.enabled 
                    ? 'Mode Pemeliharaan berhasil DIAKTIFKAN. Pemutaran musik disetop di semua perangkat.' 
                    : 'Mode Pemeliharaan berhasil DINONAKTIFKAN. Pengguna kini dapat memutar musik kembali.',
                maintenance: updated.enabled,
                config: updated
            });
        } catch (err) {
            return res.status(500).json({
                status: false,
                message: 'Gagal menyimpan pengaturan pemeliharaan: ' + err.message
            });
        }
    }

    return res.status(405).json({ status: false, message: 'Method not allowed' });
};

module.exports.getMaintenanceConfig = getMaintenanceConfig;
module.exports.isMaintenanceActive = isMaintenanceActive;
