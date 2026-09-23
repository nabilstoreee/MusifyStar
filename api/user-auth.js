const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const adminAuth = require('./admin-auth.js');
const storage = require('./storage.js');

const USER_JWT_SECRET = process.env.USER_JWT_SECRET || 'musifystar_user_secret_key_v2_sign_98741';

function safeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

function createSignedUserToken(userId, username) {
    const payload = {
        uid: userId,
        u: username,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60) // 30 days
    };
    const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', USER_JWT_SECRET).update(payloadStr).digest('base64url');
    return `usr_${payloadStr}.${signature}`;
}

function verifyUserToken(token) {
    if (!token || typeof token !== 'string') return null;
    const cleanToken = token.replace(/^Bearer\s+/i, '').trim();
    if (!cleanToken) return null;

    if (cleanToken.startsWith('usr_')) {
        const parts = cleanToken.slice(4).split('.');
        if (parts.length === 2) {
            const [payloadStr, signature] = parts;
            try {
                const expectedSig = crypto.createHmac('sha256', USER_JWT_SECRET).update(payloadStr).digest('base64url');
                if (safeCompare(signature, expectedSig)) {
                    const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString('utf8'));
                    if (payload && payload.uid && payload.exp && Math.floor(Date.now() / 1000) < payload.exp) {
                        return payload;
                    }
                }
            } catch (e) {}
        }
    }
    return null;
}

function getUserIdFromToken(token, db) {
    if (!token || typeof token !== 'string') return null;
    const cleanToken = token.replace(/^Bearer\s+/i, '').trim();
    if (!cleanToken) return null;
    const verified = verifyUserToken(cleanToken);
    if (verified && verified.uid) return verified.uid;
    if (db && db.sessions && db.sessions[cleanToken]) return db.sessions[cleanToken].userId;
    return null;
}

function readBanRegistry() {
    try {
        const data = storage.readData('.ban_registry.json', {});
        return (data && typeof data === 'object') ? data : {};
    } catch (e) {
        return {};
    }
}

function writeBanRegistry(registry) {
    try {
        storage.writeData('.ban_registry.json', registry || {});
    } catch (e) {
        console.error('Failed to write ban registry:', e.message);
    }
}

function readBannedIps() {
    try {
        const data = storage.readData('.banned_ips.json', {});
        return (data && typeof data === 'object') ? data : {};
    } catch (e) {
        return {};
    }
}

function writeBannedIps(ipsMap) {
    try {
        storage.writeData('.banned_ips.json', ipsMap || {});
    } catch (e) {
        console.error('Failed to write banned IPs:', e.message);
    }
}

function getIpBanStatus(ip) {
    if (!ip) return { isIpBanned: false };
    const bannedMap = readBannedIps();
    let cleanIp = String(ip).trim().toLowerCase().replace(/^::ffff:/, '');
    if (cleanIp === '::1' || cleanIp === 'localhost') cleanIp = '127.0.0.1';

    let matchKey = Object.keys(bannedMap).find(k => {
        let cleanK = k.trim().toLowerCase().replace(/^::ffff:/, '');
        if (cleanK === '::1' || cleanK === 'localhost') cleanK = '127.0.0.1';
        if (!cleanK) return false;
        return cleanK === cleanIp || cleanIp.startsWith(cleanK) || cleanK.startsWith(cleanIp);
    });

    if (!matchKey) return { isIpBanned: false };

    const rec = bannedMap[matchKey];
    if (rec.banType === 'temporary' && rec.banExpiresAt) {
        if (new Date(rec.banExpiresAt).getTime() <= Date.now()) {
            delete bannedMap[matchKey];
            writeBannedIps(bannedMap);
            return { isIpBanned: false };
        }
    }

    let durText = rec.banDurationDays ? `${rec.banDurationDays} Hari` : '';
    if (rec.banDurationDays === 1) durText = '1 Hari 24 Jam';
    else if (rec.banDurationDays === 365) durText = '1 Tahun 365 Hari';

    return {
        isIpBanned: true,
        ip: rec.ip || ip,
        banType: rec.banType || 'permanent',
        banReason: rec.banReason || 'Alamat IP Anda telah diblokir secara khusus oleh administrator.',
        banExpiresAt: rec.banExpiresAt || null,
        banDurationDays: rec.banDurationDays || null,
        banDurationText: durText,
        createdAt: rec.createdAt
    };
}

function readData() {
    try {
        const data = storage.readData('users.json', { users: [], sessions: {} });
        const result = (data && typeof data === 'object') ? data : { users: [], sessions: {} };
        if (!Array.isArray(result.users)) result.users = [];
        if (!result.sessions || typeof result.sessions !== 'object') result.sessions = {};

        // Anti-Tamper Ban Registry Verification
        const banRegistry = readBanRegistry();
        if (result.users && Array.isArray(result.users)) {
            result.users.forEach(u => {
                if (u && u.id && banRegistry[u.id]) {
                    const reg = banRegistry[u.id];
                    if (reg.banType && reg.banType !== 'none') {
                        let isStillBanned = true;
                        if (reg.banType === 'temporary' && reg.banExpiresAt) {
                            if (new Date(reg.banExpiresAt).getTime() <= Date.now()) {
                                isStillBanned = false;
                            }
                        }
                        if (isStillBanned) {
                            u.banType = reg.banType;
                            u.banReason = reg.banReason;
                            u.banExpiresAt = reg.banExpiresAt;
                            u.banDurationDays = reg.banDurationDays;
                        }
                    }
                }
            });
        }
        return result;
    } catch (e) {
        return { users: [], sessions: {} };
    }
}

function writeData(data) {
    try {
        storage.writeData('users.json', data || { users: [], sessions: {} });
    } catch (e) {
        console.error('Failed to write users data:', e.message);
    }
}

function hashPassword(password, salt) {
    const s = salt || crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, s, 1000, 64, 'sha512').toString('hex');
    return { hash, salt: s };
}

function verifyPassword(password, storedHash, storedSalt) {
    const hash = crypto.pbkdf2Sync(password, storedSalt, 1000, 64, 'sha512').toString('hex');
    return hash === storedHash;
}

function getClientIp(req) {
    let ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || req.ip || '127.0.0.1';
    if (typeof ip === 'string' && ip.includes(',')) {
        ip = ip.split(',')[0].trim();
    }
    if (ip === '::1' || ip === '::ffff:127.0.0.1') ip = '127.0.0.1';
    return ip;
}

function maskPassword(str) {
    return '••••••••';
}

function maskEmail(email) {
    if (!email || typeof email !== 'string') return 'u***@gmail.com';
    const clean = email.trim().toLowerCase();
    if (!clean.includes('@')) return clean.slice(0, 2) + '***';
    const [name, domain] = clean.split('@');
    if (name.length <= 2) return name[0] + '***@' + domain;
    return name[0] + '***' + name[name.length - 1] + '@' + domain;
}

function maskIp(ip) {
    if (!ip || typeof ip !== 'string') return '127.0.***.***';
    let clean = String(ip).trim().replace(/^::ffff:/, '');
    if (clean.includes(':')) {
        const parts = clean.split(':');
        if (parts.length >= 2) {
            return parts[0] + ':' + parts[1] + ':****:****:****';
        }
        return '2402:8780:****:****';
    } else {
        const parts = clean.split('.');
        if (parts.length === 4) {
            return parts[0] + '.' + parts[1] + '.***.***';
        }
        return parts[0] + '.***.***.***';
    }
}

function getUserBanStatus(user) {
    if (!user || !user.banType || user.banType === 'none') {
        return { isBanned: false, isWarning: false, banType: 'none', banReason: '', banExpiresAt: null, banDurationText: '' };
    }

    if (user.banType === 'permanent') {
        return {
            isBanned: true,
            isWarning: false,
            banType: 'permanent',
            banDurationText: 'Permanen',
            banReason: user.banReason || 'Akun Anda telah diblokir secara permanen oleh administrator karena pelanggaran.',
            banExpiresAt: null
        };
    }

    if (user.banType === 'temporary') {
        if (user.banExpiresAt && new Date(user.banExpiresAt).getTime() > Date.now()) {
            let durText = user.banDurationDays ? `${user.banDurationDays} Hari` : '';
            if (user.banDurationDays === 1) durText = '1Hari 24Jam';
            if (user.banDurationDays === 5) durText = '5Hari';
            else if (user.banDurationDays === 7) durText = '7Hari';
            else if (user.banDurationDays === 10) durText = '10Hari';
            else if (user.banDurationDays === 20) durText = '20Hari';
            else if (user.banDurationDays === 30) durText = '1Bulan 30Hari';
            else if (user.banDurationDays === 60) durText = '2Bulan 60Hari';
            else if (user.banDurationDays === 365) durText = '1Tahun 365Hari';
            else if (user.banDurationDays === 730) durText = '2Tahun 730Hari';
            else if (user.banDurationDays === 1095) durText = '3Tahun 1095Hari';
            else if (user.banDurationDays === 1460) durText = '4Tahun 1460Hari';
            else if (user.banDurationDays === 1825) durText = '5Tahun 1825Hari';
            else if (user.banDurationDays === 3650) durText = '10Tahun 3650Hari';
            else if (user.banDurationDays === 10950) durText = '30Tahun 10950Hari';
            else if (user.banDurationDays === 14600) durText = '40Tahun 14600Hari';
            else if (user.banDurationDays === 18250) durText = '50Tahun 18250Hari';
            else if (user.banDurationDays === 32850) durText = '90Tahun 32850Hari';
            else if (user.banDurationDays === 36500) durText = '100Tahun 36500Hari';


            if (!durText && user.banExpiresAt) {
                const diffMs = new Date(user.banExpiresAt).getTime() - Date.now();
                const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
                durText = `${diffDays} Hari`;
            }

            return {
                isBanned: true,
                isWarning: false,
                banType: 'temporary',
                banDurationText: durText || 'Sementara',
                banDurationDays: user.banDurationDays || null,
                banReason: user.banReason || 'Akun Anda sedang diblokir sementara oleh administrator.',
                banExpiresAt: user.banExpiresAt
            };
        } else {
            // Ban expired
            return { isBanned: false, isWarning: false, banType: 'none', banReason: '', banExpiresAt: null, banDurationText: '' };
        }
    }

    if (user.banType === 'warning') {
        return {
            isBanned: false,
            isWarning: true,
            banType: 'warning',
            banDurationText: 'Peringatan Akun',
            banReason: user.banReason || 'Peringatan Akun dari Administrator.',
            banExpiresAt: user.banExpiresAt || null
        };
    }

    return { isBanned: false, isWarning: false, banType: 'none', banReason: '', banExpiresAt: null, banDurationText: '' };
}

module.exports = async (req, res) => {
    // Anti-Cache & CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-token');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const action = (req.query.action || req.body?.action || '').toLowerCase();
        let body = req.body;
        if (typeof body === 'string') {
            try { body = JSON.parse(body); } catch (e) { body = {}; }
        }
        body = body || {};

    const db = readData();
    const clientIp = getClientIp(req);

    // ==========================================
    // 1. ADMIN ACTIONS (Requires Admin Token)
    // ==========================================
    if (action.startsWith('admin_')) {
        const adminToken = req.headers['x-admin-token'] || body.adminToken || req.query.adminToken;
        if (!adminToken || !adminAuth.verifyToken(adminToken)) {
            return res.status(401).json({ status: false, message: 'Akses Ditolak: Token admin tidak valid atau sesi berakhir' });
        }

        // GET ALL USERS WITH LOGIN LOGS, IP, PASSWORD SENSOR & BAN STATUS
        if (action === 'admin_get_users') {
            const userList = db.users.map(u => {
                const banStatus = getUserBanStatus(u);
                return {
                    id: u.id,
                    username: u.username,
                    email: u.rawEmail || u.email,
                    avatar: u.avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(u.username)}`,
                    createdAt: u.createdAt,
                    lastLoginAt: u.lastLoginAt || u.createdAt,
                    lastIp: u.rawLastIp || u.lastIp || '127.0.0.1',
                    maskedPassword: '••••••••',
                    banType: u.banType || 'none',
                    banReason: u.banReason || '',
                    banExpiresAt: u.banExpiresAt || null,
                    banStatus: banStatus,
                    loginLogs: (u.loginLogs || []).map(l => ({
                        ip: l.rawIp || l.ip || '127.0.0.1',
                        timestamp: l.timestamp,
                        userAgent: l.userAgent
                    }))
                };
            });

            return res.json({ status: true, users: userList });
        }

        // BAN / WARN / UNBAN USER
        if (action === 'admin_ban_user') {
            const targetId = String(body.targetId || body.userId || body.id || '').trim();
            const targetUsername = String(body.username || '').trim().toLowerCase();
            const targetEmail = String(body.email || '').trim().toLowerCase();
            const targetIp = String(body.ip || '').trim().toLowerCase();

            const banType = String(body.banType || 'none').toLowerCase(); // 'none', 'permanent', 'temporary', 'warning'
            const durationDays = Number(body.durationDays || 0); // e.g. 365, 900, custom
            const banReason = String(body.banReason || '').trim();

            let userIndex = -1;

            if (targetId) {
                userIndex = db.users.findIndex(u => u.id === targetId || u.id.toLowerCase() === targetId.toLowerCase());
                if (userIndex === -1) {
                    userIndex = db.users.findIndex(u => u.id.toLowerCase().includes(targetId.toLowerCase()));
                }
            } else if (targetUsername) {
                userIndex = db.users.findIndex(u => u.username && u.username.toLowerCase() === targetUsername);
            } else if (targetEmail) {
                userIndex = db.users.findIndex(u =>
                    (u.email && u.email.toLowerCase() === targetEmail) ||
                    (u.rawEmail && u.rawEmail.toLowerCase() === targetEmail)
                );
            } else if (targetIp) {
                userIndex = db.users.findIndex(u =>
                    (u.lastIp || '').toLowerCase().includes(targetIp) ||
                    (u.rawLastIp || '').toLowerCase().includes(targetIp) ||
                    (u.loginLogs || []).some(l => (l.ip || '').toLowerCase().includes(targetIp) || (l.rawIp || '').toLowerCase().includes(targetIp))
                );
            }

            if (userIndex === -1) {
                const queryInfo = targetId ? `User ID "${targetId}"` : targetUsername ? `Username "@${targetUsername}"` : targetEmail ? `Email "${targetEmail}"` : targetIp ? `IP "${targetIp}"` : 'kriteria tersebut';
                return res.status(404).json({ status: false, message: `Pengguna dengan ${queryInfo} tidak ditemukan.` });
            }

            const user = db.users[userIndex];
            user.banType = banType;
            if (banType === 'none') {
                user.banReason = '';
                user.banExpiresAt = null;
                user.banDurationDays = null;
            } else {
                user.banReason = banReason || 'Akun Anda telah diblokir atau diberikan sanksi oleh administrator.';
            }

            if (banType === 'temporary' && durationDays > 0) {
                const expires = new Date();
                expires.setDate(expires.getDate() + durationDays);
                user.banExpiresAt = expires.toISOString();
                user.banDurationDays = durationDays;
            } else {
                user.banExpiresAt = null;
                user.banDurationDays = null;
            }

            // Update Ban Registry for Anti-Tamper Protection
            const banRegistry = readBanRegistry();
            if (banType === 'none') {
                delete banRegistry[user.id];
            } else {
                banRegistry[user.id] = {
                    userId: user.id,
                    username: user.username,
                    banType: user.banType,
                    banReason: user.banReason,
                    banExpiresAt: user.banExpiresAt,
                    banDurationDays: user.banDurationDays,
                    updatedAt: new Date().toISOString()
                };
            }
            writeBanRegistry(banRegistry);

            // If user is banned (permanent or temporary), invalidate all their active sessions immediately
            if (banType === 'permanent' || banType === 'temporary') {
                Object.keys(db.sessions).forEach(tok => {
                    if (db.sessions[tok].userId === user.id) {
                        delete db.sessions[tok];
                    }
                });
            }

            db.users[userIndex] = user;
            writeData(db);

            return res.json({
                status: true,
                message: `Status sanksi & blokir akun @${user.username} berhasil diperbarui!`,
                banStatus: getUserBanStatus(user),
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                    lastIp: user.lastIp
                }
            });
        }

        // DELETE USER
        if (action === 'admin_delete_user') {
            const userId = body.userId;
            const userIndex = db.users.findIndex(u => u.id === userId);
            if (userIndex === -1) {
                return res.status(404).json({ status: false, message: 'Pengguna tidak ditemukan' });
            }

            // Remove sessions
            Object.keys(db.sessions).forEach(tok => {
                if (db.sessions[tok].userId === userId) {
                    delete db.sessions[tok];
                }
            });

            db.users.splice(userIndex, 1);
            writeData(db);

            return res.json({ status: true, message: 'Akun pengguna berhasil dihapus permanen' });
        }

        // BAN / UNBAN IP ADDRESS (DEDICATED IP BLACKLIST)
        if (action === 'admin_ban_ip') {
            const targetIp = String(body.targetIp || body.ip || '').trim();
            const banType = String(body.banType || 'permanent').toLowerCase(); // 'permanent', 'temporary', 'none'
            const durationDays = Number(body.durationDays || 0);
            const banReason = String(body.banReason || '').trim() || 'Alamat IP Anda telah diblokir secara khusus oleh administrator.';

            if (!targetIp) {
                return res.status(400).json({ status: false, message: 'Alamat IP target wajib diisi' });
            }

            const bannedIps = readBannedIps();

            if (banType === 'none') {
                delete bannedIps[targetIp];
                writeBannedIps(bannedIps);
                return res.json({ status: true, message: `Blokir IP "${targetIp}" berhasil dibuka (dihapus dari blacklist IP)` });
            }

            let expiresIso = null;
            if (banType === 'temporary' && durationDays > 0) {
                const expires = new Date();
                expires.setDate(expires.getDate() + durationDays);
                expiresIso = expires.toISOString();
            }

            bannedIps[targetIp] = {
                ip: targetIp,
                banType: banType,
                banReason: banReason,
                banExpiresAt: expiresIso,
                banDurationDays: durationDays > 0 ? durationDays : null,
                createdAt: new Date().toISOString()
            };

            writeBannedIps(bannedIps);

            return res.json({
                status: true,
                message: `Alamat IP "${targetIp}" berhasil dibanned (${banType === 'permanent' ? 'Permanen' : 'Sementara'})!`,
                ipBan: getIpBanStatus(targetIp)
            });
        }

        // GET ALL BANNED IPS
        if (action === 'admin_get_banned_ips') {
            const bannedIps = readBannedIps();
            const list = Object.values(bannedIps).map(item => {
                let durText = item.banDurationDays ? `${item.banDurationDays} Hari` : '';
                if (item.banDurationDays === 1) durText = '1 Hari 24 Jam';
                else if (item.banDurationDays === 365) durText = '1 Tahun 365 Hari';

                return {
                    ip: item.ip,
                    banType: item.banType || 'permanent',
                    banReason: item.banReason || 'IP Blacklisted',
                    banExpiresAt: item.banExpiresAt || null,
                    banDurationDays: item.banDurationDays || null,
                    banDurationText: durText,
                    createdAt: item.createdAt
                };
            });

            return res.json({ status: true, bannedIps: list });
        }

        // UNBAN IP
        if (action === 'admin_unban_ip') {
            const targetIp = String(body.targetIp || body.ip || '').trim();
            if (!targetIp) {
                return res.status(400).json({ status: false, message: 'Alamat IP target wajib diisi' });
            }

            const bannedIps = readBannedIps();
            delete bannedIps[targetIp];
            writeBannedIps(bannedIps);

            return res.json({ status: true, message: `Alamat IP "${targetIp}" telah bebas dari blacklist IP!` });
        }

        return res.status(400).json({ status: false, message: 'Action admin tidak dikenal' });
    }

    // ==========================================
    // 2. USER ACTIONS (GET ME, LOGIN, REGISTER, ETC)
    // ==========================================

    // First check if current client IP is IP-Banned
    const ipBanCheck = getIpBanStatus(clientIp);
    if (ipBanCheck.isIpBanned) {
        return res.json({
            status: false,
            ipBanned: true,
            banned: true,
            ban: {
                isBanned: true,
                isIpBanned: true,
                ip: clientIp,
                banType: ipBanCheck.banType,
                banReason: ipBanCheck.banReason,
                banExpiresAt: ipBanCheck.banExpiresAt,
                banDurationDays: ipBanCheck.banDurationDays,
                banDurationText: ipBanCheck.banDurationText
            },
            message: 'ALAMAT IP ANDA DIBLOKIR / DIBANNED KHUSUS OLEH ADMINISTRATOR'
        });
    }

    // GET /api/user-auth?action=check_account_ban
    if (action === 'check_account_ban') {
        const targetUsername = String(req.query.username || body.username || '').trim().toLowerCase();
        const targetEmail = String(req.query.email || body.email || '').trim().toLowerCase();
        const targetUserId = String(req.query.userId || body.userId || '').trim();

        const user = db.users.find(u => {
            if (targetUserId && u.id === targetUserId) return true;
            if (targetUsername && u.username && u.username.toLowerCase() === targetUsername) return true;
            if (targetEmail && ((u.rawEmail && u.rawEmail.toLowerCase() === targetEmail) || u.email.toLowerCase() === targetEmail)) return true;
            return false;
        });

        if (!user) {
            return res.json({ status: true, banned: false });
        }

        const banStatus = getUserBanStatus(user);
        return res.json({
            status: true,
            banned: banStatus.isBanned,
            ban: banStatus
        });
    }

    // GET /api/user-auth?action=me
    if (req.method === 'GET' || action === 'me') {
        const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.token;
        if (!token) {
            return res.json({ status: true, authenticated: false, user: null });
        }

        const targetUserId = getUserIdFromToken(token, db);
        if (!targetUserId) {
            return res.json({ status: true, authenticated: false, user: null });
        }

        const user = db.users.find(u => u.id === targetUserId);
        if (!user) {
            if (db.sessions && db.sessions[token]) {
                delete db.sessions[token];
                writeData(db);
            }
            return res.json({ status: true, authenticated: false, user: null });
        }

        const banStatus = getUserBanStatus(user);

        return res.json({
            status: true,
            authenticated: true,
            banned: banStatus.isBanned,
            ban: banStatus,
            user: {
                id: user.id,
                username: user.username,
                email: user.rawEmail || user.email,
                rawEmail: user.rawEmail || user.email,
                avatar: user.avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(user.username)}`,
                createdAt: user.createdAt
            }
        });
    }

    // POST /api/user-auth?action=register
    if (action === 'register') {
        const username = String(body.username || '').trim();
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '').trim();

        if (!username) {
            return res.status(400).json({ status: false, message: 'Username wajib diisi' });
        }
        if (username.length < 3) {
            return res.status(400).json({ status: false, message: 'Username minimal 3 karakter' });
        }
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ status: false, message: 'Format email tidak valid' });
        }
        if (!password || password.length < 6) {
            return res.status(400).json({ status: false, message: 'Password minimal 6 karakter/huruf' });
        }

        // Check if username or email already exists
        const existsUser = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
        if (existsUser) {
            return res.status(400).json({ status: false, message: 'Username sudah digunakan, silakan pilih yang lain' });
        }
        const existsEmail = db.users.find(u => (u.rawEmail && u.rawEmail.toLowerCase() === email.toLowerCase()) || u.email.toLowerCase() === email.toLowerCase());
        if (existsEmail) {
            return res.status(400).json({ status: false, message: 'Email sudah terdaftar, silakan login' });
        }

        const { hash, salt } = hashPassword(password);
        const nowIso = new Date().toISOString();
        const maskedClientIp = maskIp(clientIp);
        const maskedUserEmail = maskEmail(email);
        const newUser = {
            id: 'u_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'),
            username: username,
            email: maskedUserEmail,
            rawEmail: email,
            passwordHash: hash,
            passwordSalt: salt,
            maskedPassword: '••••••••',
            avatar: `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(username)}`,
            createdAt: nowIso,
            lastLoginAt: nowIso,
            lastIp: maskedClientIp,
            rawLastIp: clientIp,
            banType: 'none',
            banReason: '',
            banExpiresAt: null,
            loginLogs: [
                {
                    ip: maskedClientIp,
                    rawIp: clientIp,
                    timestamp: nowIso,
                    userAgent: req.headers['user-agent'] || ''
                }
            ]
        };

        db.users.push(newUser);

        // Auto login after register
        const token = createSignedUserToken(newUser);
        db.sessions = db.sessions || {};
        db.sessions[token] = {
            userId: newUser.id,
            createdAt: Date.now(),
            rememberMe: true
        };

        writeData(db);

        return res.json({
            status: true,
            message: 'Pendaftaran berhasil!',
            token: token,
            ban: getUserBanStatus(newUser),
            user: {
                id: newUser.id,
                username: newUser.username,
                email: newUser.email,
                avatar: newUser.avatar,
                createdAt: newUser.createdAt
            }
        });
    }

    // POST /api/user-auth?action=login
    if (action === 'login') {
        const username = String(body.username || '').trim();
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '').trim();
        const rememberMe = body.rememberMe !== false;

        if (!username && !email) {
            return res.status(400).json({ status: false, message: 'Username atau Email wajib diisi' });
        }
        if (!password || password.length < 6) {
            return res.status(400).json({ status: false, message: 'Password minimal 6 karakter/huruf' });
        }

        // Find user by username or email
        const user = db.users.find(u => {
            if (username && u.username.toLowerCase() === username.toLowerCase()) return true;
            if (email && ((u.rawEmail && u.rawEmail.toLowerCase() === email.toLowerCase()) || u.email.toLowerCase() === email.toLowerCase() || u.email.toLowerCase() === maskEmail(email).toLowerCase())) return true;
            return false;
        });

        if (!user) {
            return res.status(401).json({ status: false, message: 'Akun tidak ditemukan. Silakan periksa kembali username/email atau daftar baru.' });
        }

        const isMatch = verifyPassword(password, user.passwordHash, user.passwordSalt);
        if (!isMatch) {
            return res.status(401).json({ status: false, message: 'Password salah. Silakan coba lagi.' });
        }

        // Check if user is BANNED
        const banStatus = getUserBanStatus(user);
        if (banStatus.isBanned) {
            return res.json({
                status: false,
                banned: true,
                ban: banStatus,
                message: banStatus.banReason || 'Akun Anda sedang diblokir oleh administrator.'
            });
        }

        // Record Login Log & IP
        const nowIso = new Date().toISOString();
        const maskedClientIp = maskIp(clientIp);
        user.lastLoginAt = nowIso;
        user.lastIp = maskedClientIp;
        user.rawLastIp = clientIp;
        user.maskedPassword = '••••••••';
        user.loginLogs = user.loginLogs || [];
        user.loginLogs.unshift({
            ip: maskedClientIp,
            rawIp: clientIp,
            timestamp: nowIso,
            userAgent: req.headers['user-agent'] || ''
        });
        if (user.loginLogs.length > 20) {
            user.loginLogs = user.loginLogs.slice(0, 20);
        }

        const token = createSignedUserToken(user.id, user.username);
        db.sessions = db.sessions || {};
        db.sessions[token] = {
            userId: user.id,
            createdAt: Date.now(),
            rememberMe: rememberMe
        };

        writeData(db);

        return res.json({
            status: true,
            message: 'Login berhasil!',
            token: token,
            ban: banStatus,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                avatar: user.avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(user.username)}`,
                createdAt: user.createdAt
            }
        });
    }

    // POST /api/user-auth?action=update_profile
    if (action === 'update_profile') {
        const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.body?.token;
        const targetUserId = getUserIdFromToken(token, db);
        if (!targetUserId) {
            return res.status(401).json({ status: false, message: 'Sesi login tidak valid atau sudah berakhir' });
        }
        const userIndex = db.users.findIndex(u => u.id === targetUserId);
        if (userIndex === -1) {
            return res.status(404).json({ status: false, message: 'Pengguna tidak ditemukan' });
        }

        const user = db.users[userIndex];

        // Update username if provided
        if (body.username !== undefined) {
            const newUsername = String(body.username).trim();
            if (!newUsername || newUsername.length < 3) {
                return res.status(400).json({ status: false, message: 'Username minimal 3 karakter' });
            }
            const exists = db.users.find(u => u.id !== user.id && u.username.toLowerCase() === newUsername.toLowerCase());
            if (exists) {
                return res.status(400).json({ status: false, message: 'Username sudah digunakan orang lain' });
            }
            user.username = newUsername;
        }

        // Update email if provided
        if (body.email !== undefined) {
            const newEmail = String(body.email).trim().toLowerCase();
            if (!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
                return res.status(400).json({ status: false, message: 'Format email tidak valid' });
            }
            const exists = db.users.find(u => u.id !== user.id && u.email.toLowerCase() === newEmail.toLowerCase());
            if (exists) {
                return res.status(400).json({ status: false, message: 'Email sudah digunakan akun lain' });
            }
            user.email = newEmail;
        }

        // Update avatar (from device gallery) if provided
        if (body.avatar !== undefined) {
            user.avatar = body.avatar;
        }

        db.users[userIndex] = user;
        writeData(db);

        return res.json({
            status: true,
            message: 'Profil berhasil diperbarui!',
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                avatar: user.avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(user.username)}`,
                createdAt: user.createdAt
            }
        });
    }

    // POST /api/user-auth?action=update_password
    if (action === 'update_password') {
        const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.body?.token;
        const targetUserId = getUserIdFromToken(token, db);
        if (!targetUserId) {
            return res.status(401).json({ status: false, message: 'Sesi login tidak valid' });
        }
        const user = db.users.find(u => u.id === targetUserId);
        if (!user) {
            return res.status(404).json({ status: false, message: 'Pengguna tidak ditemukan' });
        }

        const oldPassword = String(body.oldPassword || '').trim();
        const newPassword = String(body.newPassword || '').trim();

        if (oldPassword) {
            const isMatch = verifyPassword(oldPassword, user.passwordHash, user.passwordSalt);
            if (!isMatch) {
                return res.status(400).json({ status: false, message: 'Password saat ini salah' });
            }
        }

        if (!newPassword || newPassword.length < 6) {
            return res.status(400).json({ status: false, message: 'Password baru minimal 6 karakter/huruf' });
        }

        const { hash, salt } = hashPassword(newPassword);
        user.passwordHash = hash;
        user.passwordSalt = salt;
        user.maskedPassword = maskPassword(newPassword);
        writeData(db);

        return res.json({
            status: true,
            message: 'Password berhasil diubah!'
        });
    }

    // POST /api/user-auth?action=logout
    if (action === 'logout') {
        const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.body?.token;
        if (token && db.sessions[token]) {
            delete db.sessions[token];
            writeData(db);
        }
        return res.json({ status: true, message: 'Logout berhasil' });
    }

    res.status(400).json({ status: false, message: 'Action tidak dikenal' });
    } catch (err) {
        console.error('User-Auth Handler Error:', err);
        return res.status(500).json({ status: false, message: 'Terjadi kesalahan server internal: ' + err.message });
    }
};
