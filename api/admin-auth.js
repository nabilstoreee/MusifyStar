const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CRED_FILE = path.join(__dirname, '..', '.admin_credentials.json');

// In-memory active tokens cache
const activeTokens = new Set();
// In-memory pending 2FA login sessions: tempToken -> { username, expiresAt }
const pending2FASessions = new Map();
// In-memory pending 2FA setups: adminToken -> { secret, createdAt }
const pending2FASetups = new Map();

// Base32 Alphabet for TOTP (RFC 4648)
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function generateBase32Secret(length = 20) {
    const bytes = crypto.randomBytes(length);
    let secret = '';
    for (let i = 0; i < bytes.length; i++) {
        secret += BASE32_ALPHABET[bytes[i] % 32];
    }
    return secret;
}

function base32Decode(base32) {
    const clean = String(base32).toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '');
    let bits = '';
    for (let i = 0; i < clean.length; i++) {
        const val = BASE32_ALPHABET.indexOf(clean[i]);
        if (val === -1) continue;
        bits += val.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
        bytes.push(parseInt(bits.substring(i, i + 8), 2));
    }
    return Buffer.from(bytes);
}

function generateTOTP(secretBase32, timeStep = 30, windowOffset = 0) {
    try {
        const key = base32Decode(secretBase32);
        const epoch = Math.floor(Date.now() / 1000);
        const counter = Math.floor(epoch / timeStep) + windowOffset;

        const buf = Buffer.alloc(8);
        buf.writeBigUInt64BE(BigInt(counter));

        const hmac = crypto.createHmac('sha1', key);
        hmac.update(buf);
        const digest = hmac.digest();

        const offset = digest[digest.length - 1] & 0xf;
        const binary = ((digest[offset] & 0x7f) << 24) |
            ((digest[offset + 1] & 0xff) << 16) |
            ((digest[offset + 2] & 0xff) << 8) |
            (digest[offset + 3] & 0xff);

        const otp = binary % 1000000;
        return otp.toString().padStart(6, '0');
    } catch (e) {
        return null;
    }
}

function verifyTOTP(secretBase32, code, timeStep = 30, window = 2) {
    if (!code || typeof code !== 'string') return false;
    const cleanCode = code.trim().replace(/\s+/g, '');
    if (cleanCode.length !== 6 || !/^\d{6}$/.test(cleanCode)) return false;

    for (let i = -window; i <= window; i++) {
        const generated = generateTOTP(secretBase32, timeStep, i);
        if (generated && safeCompare(generated, cleanCode)) {
            return true;
        }
    }
    return false;
}

function hashPassword(password, salt) {
    return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
}

function safeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

function getStoredCredentials() {
    // 1. Check runtime storage file first
    if (fs.existsSync(CRED_FILE)) {
        try {
            const raw = fs.readFileSync(CRED_FILE, 'utf8');
            const data = JSON.parse(raw);
            if (data && data.username && data.hash && data.salt) {
                return {
                    type: 'file',
                    username: data.username,
                    hash: data.hash,
                    salt: data.salt,
                    twoFactorEnabled: Boolean(data.twoFactorEnabled),
                    twoFactorSecret: data.twoFactorSecret || null,
                    twoFactorEnabledAt: data.twoFactorEnabledAt || null
                };
            }
        } catch (e) {}
    }

    // 2. Fallback to environment variables if no credential file
    const envUser = process.env.ADMIN_USERNAME;
    const envPass = process.env.ADMIN_PASSWORD;

    if (envUser && envPass) {
        return {
            type: 'env',
            username: envUser.trim(),
            password: envPass.trim(),
            twoFactorEnabled: false,
            twoFactorSecret: null
        };
    }

    return null;
}

module.exports = function (req, res) {
    res.setHeader('Content-Type', 'application/json');

    const method = req.method.toUpperCase();

    if (method === 'GET') {
        const token = req.headers['x-admin-token'] || req.query.token;
        const creds = getStoredCredentials();
        const isAuthenticated = Boolean(token && activeTokens.has(token));

        return res.json({
            status: true,
            hasCredentials: Boolean(creds),
            authenticated: isAuthenticated,
            twoFactorEnabled: creds ? Boolean(creds.twoFactorEnabled) : false
        });
    }

    if (method === 'POST') {
        const body = req.body || {};
        const action = body.action || 'login';
        const username = typeof body.username === 'string' ? body.username.trim() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        const token = body.token || req.headers['x-admin-token'];

        // Clean up expired 2FA login temp tokens
        const now = Date.now();
        for (const [tToken, info] of pending2FASessions.entries()) {
            if (now > info.expiresAt) {
                pending2FASessions.delete(tToken);
            }
        }

        if (action === 'logout') {
            if (token) activeTokens.delete(token);
            return res.json({ status: true, message: 'Berhasil logout' });
        }

        const creds = getStoredCredentials();

        // If no credentials configured yet, allow initial first-time setup
        if (!creds) {
            if (action === 'setup') {
                if (!username || username.length < 3) {
                    return res.status(400).json({ status: false, message: 'Username minimal 3 karakter' });
                }
                if (!password || password.length < 4) {
                    return res.status(400).json({ status: false, message: 'Password minimal 4 karakter' });
                }

                const salt = crypto.randomBytes(16).toString('hex');
                const hash = hashPassword(password, salt);

                try {
                    fs.writeFileSync(CRED_FILE, JSON.stringify({
                        username: username,
                        hash: hash,
                        salt: salt,
                        twoFactorEnabled: false,
                        twoFactorSecret: null,
                        createdAt: new Date().toISOString()
                    }, null, 2), 'utf8');

                    const sessionToken = crypto.randomBytes(32).toString('hex');
                    activeTokens.add(sessionToken);

                    return res.json({
                        status: true,
                        success: true,
                        token: sessionToken,
                        message: 'Kredensial admin berhasil dibuat'
                    });
                } catch (err) {
                    return res.status(500).json({ status: false, message: 'Gagal menyimpan kredensial' });
                }
            }

            return res.json({
                status: true,
                needsSetup: true,
                message: 'Admin belum disetel. Silakan buat Username & Password baru.'
            });
        }

        // ==========================================
        // ACTION: VERIFY 2FA (Step 2 of 2FA Login)
        // ==========================================
        if (action === 'verify_2fa') {
            const tempToken = body.tempToken;
            const otpCode = body.otp || body.code;

            if (!tempToken || !pending2FASessions.has(tempToken)) {
                return res.status(401).json({ status: false, message: 'Sesi verifikasi 2FA kedaluwarsa atau tidak valid. Silakan login ulang.' });
            }

            const sessionInfo = pending2FASessions.get(tempToken);
            if (!creds.twoFactorSecret) {
                return res.status(500).json({ status: false, message: 'Konfigurasi 2FA pada server tidak ditemukan.' });
            }

            const isValid = verifyTOTP(creds.twoFactorSecret, String(otpCode || ''));
            if (!isValid) {
                return res.status(400).json({ status: false, message: 'Kode OTP 6 digit salah atau telah kedaluwarsa.' });
            }

            // Clean up temp token & generate real session token
            pending2FASessions.delete(tempToken);
            const fullSessionToken = crypto.randomBytes(32).toString('hex');
            activeTokens.add(fullSessionToken);

            return res.json({
                status: true,
                success: true,
                token: fullSessionToken,
                message: 'Verifikasi 2FA berhasil. Login sukses!'
            });
        }

        // ==========================================
        // ACTION: 2FA SETUP (Generate Secret & QR)
        // ==========================================
        if (action === '2fa_setup') {
            if (!token || !activeTokens.has(token)) {
                return res.status(401).json({ status: false, message: 'Akses ditolak: Membutuhkan token admin aktif' });
            }

            const secret = generateBase32Secret(20);
            const issuer = 'MusifyStar';
            const account = creds.username || 'admin';
            const otpAuthUri = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(otpAuthUri)}`;

            pending2FASetups.set(token, { secret, createdAt: Date.now() });

            // Format secret with spacing (e.g. ABCD EFGH IJKL MNOP QRST)
            const formattedSecret = secret.match(/.{1,4}/g).join(' ');

            return res.json({
                status: true,
                success: true,
                secret: secret,
                formattedSecret: formattedSecret,
                otpAuthUri: otpAuthUri,
                qrUrl: qrUrl,
                issuer: issuer,
                account: account
            });
        }

        // ==========================================
        // ACTION: 2FA ENABLE (Verify initial OTP & save)
        // ==========================================
        if (action === '2fa_enable') {
            if (!token || !activeTokens.has(token)) {
                return res.status(401).json({ status: false, message: 'Akses ditolak: Membutuhkan token admin aktif' });
            }

            const otpCode = body.otp || body.code;
            const secret = body.secret || (pending2FASetups.get(token) && pending2FASetups.get(token).secret);

            if (!secret) {
                return res.status(400).json({ status: false, message: 'Secret 2FA tidak ditemukan. Silakan mulai ulang setup 2FA.' });
            }

            const isValid = verifyTOTP(secret, String(otpCode || ''));
            if (!isValid) {
                return res.status(400).json({ status: false, message: 'Kode OTP yang dimasukkan tidak valid. Pastikan jam perangkat Anda akurat.' });
            }

            try {
                let currentFileCreds = {};
                if (fs.existsSync(CRED_FILE)) {
                    currentFileCreds = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
                } else if (creds.type === 'env') {
                    const salt = crypto.randomBytes(16).toString('hex');
                    const hash = hashPassword(creds.password, salt);
                    currentFileCreds = { username: creds.username, hash, salt };
                }

                currentFileCreds.twoFactorEnabled = true;
                currentFileCreds.twoFactorSecret = secret;
                currentFileCreds.twoFactorEnabledAt = new Date().toISOString();

                fs.writeFileSync(CRED_FILE, JSON.stringify(currentFileCreds, null, 2), 'utf8');
                pending2FASetups.delete(token);

                return res.json({
                    status: true,
                    success: true,
                    message: 'Two-Factor Authentication (2FA) berhasil diaktifkan!'
                });
            } catch (err) {
                return res.status(500).json({ status: false, message: 'Gagal menyimpan pengaturan 2FA: ' + err.message });
            }
        }

        // ==========================================
        // ACTION: 2FA DISABLE (Turn off 2FA)
        // ==========================================
        if (action === '2fa_disable') {
            if (!token || !activeTokens.has(token)) {
                return res.status(401).json({ status: false, message: 'Akses ditolak: Membutuhkan token admin aktif' });
            }

            const verifyPassword = body.password;
            if (verifyPassword) {
                let isPassMatch = false;
                if (creds.type === 'env') {
                    isPassMatch = safeCompare(verifyPassword, creds.password);
                } else if (creds.type === 'file') {
                    const calculatedHash = hashPassword(verifyPassword, creds.salt);
                    isPassMatch = safeCompare(calculatedHash, creds.hash);
                }
                if (!isPassMatch) {
                    return res.status(400).json({ status: false, message: 'Password konfirmasi salah' });
                }
            }

            try {
                let currentFileCreds = {};
                if (fs.existsSync(CRED_FILE)) {
                    currentFileCreds = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
                }

                currentFileCreds.twoFactorEnabled = false;
                currentFileCreds.twoFactorSecret = null;
                currentFileCreds.twoFactorDisabledAt = new Date().toISOString();

                fs.writeFileSync(CRED_FILE, JSON.stringify(currentFileCreds, null, 2), 'utf8');

                return res.json({
                    status: true,
                    success: true,
                    message: 'Two-Factor Authentication (2FA) berhasil dinonaktifkan'
                });
            } catch (err) {
                return res.status(500).json({ status: false, message: 'Gagal menonaktifkan 2FA: ' + err.message });
            }
        }

        // ==========================================
        // ACTION: CHANGE ADMIN PASSWORD
        // ==========================================
        if (action === 'change_password') {
            const oldPassword = typeof body.oldPassword === 'string' ? body.oldPassword : '';
            const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

            // Verify authentication (either valid token or old password)
            const isAuthByToken = Boolean(token && activeTokens.has(token));
            let isOldPassValid = false;

            if (creds.type === 'env') {
                isOldPassValid = safeCompare(oldPassword, creds.password);
            } else if (creds.type === 'file') {
                const calculatedOldHash = hashPassword(oldPassword, creds.salt);
                isOldPassValid = safeCompare(calculatedOldHash, creds.hash);
            }

            if (!isAuthByToken && !isOldPassValid) {
                return res.status(401).json({ status: false, message: 'Password lama tidak valid atau sesi berakhir' });
            }

            if (oldPassword && !isOldPassValid) {
                return res.status(400).json({ status: false, message: 'Password lama yang Anda masukkan salah' });
            }

            if (!newPassword || newPassword.length < 4) {
                return res.status(400).json({ status: false, message: 'Password baru minimal 4 karakter' });
            }

            const newSalt = crypto.randomBytes(16).toString('hex');
            const newHash = hashPassword(newPassword, newSalt);
            const targetUsername = creds.username || username || 'musikstar';

            try {
                let currentFileCreds = {};
                if (fs.existsSync(CRED_FILE)) {
                    try { currentFileCreds = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')); } catch (e) {}
                }

                currentFileCreds.username = targetUsername;
                currentFileCreds.hash = newHash;
                currentFileCreds.salt = newSalt;
                currentFileCreds.updatedAt = new Date().toISOString();

                fs.writeFileSync(CRED_FILE, JSON.stringify(currentFileCreds, null, 2), 'utf8');

                return res.json({
                    status: true,
                    success: true,
                    message: 'Password admin berhasil diperbarui secara aman!'
                });
            } catch (err) {
                return res.status(500).json({ status: false, message: 'Gagal menyimpan password baru: ' + err.message });
            }
        }

        // ==========================================
        // ACTION: LOGIN (Step 1)
        // ==========================================
        if (!username || !password) {
            return res.status(400).json({ status: false, message: 'Username dan password wajib diisi' });
        }

        let isMatch = false;

        if (creds.type === 'env') {
            const userMatch = safeCompare(username, creds.username);
            const passMatch = safeCompare(password, creds.password);
            isMatch = userMatch && passMatch;
        } else if (creds.type === 'file') {
            if (safeCompare(username, creds.username)) {
                const calculatedHash = hashPassword(password, creds.salt);
                isMatch = safeCompare(calculatedHash, creds.hash);
            }
        }

        if (!isMatch) {
            return res.status(401).json({ status: false, message: 'Username atau password salah' });
        }

        // If 2FA is active, require OTP verification before giving full token
        if (creds.twoFactorEnabled && creds.twoFactorSecret) {
            const tempToken = 'temp_' + crypto.randomBytes(32).toString('hex');
            pending2FASessions.set(tempToken, {
                username: creds.username,
                expiresAt: Date.now() + 5 * 60 * 1000 // 5 minutes expiration
            });

            return res.json({
                status: true,
                require2FA: true,
                tempToken: tempToken,
                message: 'Verifikasi 2FA diperlukan. Masukkan kode 6 digit OTP.'
            });
        }

        // Direct Login without 2FA
        const sessionToken = crypto.randomBytes(32).toString('hex');
        activeTokens.add(sessionToken);

        return res.json({
            status: true,
            success: true,
            token: sessionToken,
            message: 'Login admin berhasil'
        });
    }

    return res.status(405).json({ status: false, message: 'Metode tidak didukung' });
};

module.exports.isValidToken = function (token) {
    return Boolean(token && activeTokens.has(token));
};

module.exports.verifyToken = function (token) {
    return Boolean(token && activeTokens.has(token));
};
