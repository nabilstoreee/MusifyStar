const fs = require('fs');
const path = require('path');
const adminAuth = require('./admin-auth.js');
const storage = require('./storage.js');

const THEME_FILE = '.seasonal_theme.json';

const THEMES = {
    default: {
        id: 'default',
        name: 'Default MusifyStar',
        subtitle: 'Nuansa Neon Cyberpunk & Dark Glassmorphism',
        accentColor: '#f43f5e',
        secondaryColor: '#9333ea',
        glowColor: 'rgba(244, 63, 94, 0.25)',
        badgeText: 'MusifyStar Official',
        bannerTitle: 'MusifyStar Web Music Player',
        bannerSubtitle: 'Streaming lagu favorit tanpa batas dengan lirik sinkron dan kualitas suara terbaik.',
        icon: 'music',
        festiveDecorations: 'default'
    },
    puasa: {
        id: 'puasa',
        name: 'Bulan Ramadhan (Puasa)',
        subtitle: 'Nuansa Suci Emerald & Emas Islami',
        accentColor: '#10b981',
        secondaryColor: '#f59e0b',
        glowColor: 'rgba(16, 185, 129, 0.3)',
        badgeText: '🌙 Marhaban Ya Ramadhan',
        bannerTitle: 'Bulan Suci Ramadhan',
        bannerSubtitle: 'Selamat Menunaikan Ibadah Puasa. Semoga hari-hari Anda dilimpahi keberkahan, kedamaian, dan kebaikan.',
        icon: 'moon',
        festiveDecorations: 'ramadhan'
    },
    lebaran: {
        id: 'lebaran',
        name: 'Hari Raya Idul Fitri (Lebaran)',
        subtitle: 'Nuansa Kemenangan Hijau Zamrud & Ketupat Emas',
        accentColor: '#059669',
        secondaryColor: '#eab308',
        glowColor: 'rgba(5, 150, 105, 0.35)',
        badgeText: '✨ Selamat Idul Fitri',
        bannerTitle: 'Hari Raya Idul Fitri',
        bannerSubtitle: 'Taqabbalallahu Minna Wa Minkum. Minal Aidin Wal Faizin — Mohon Maaf Lahir dan Batin.',
        icon: 'sparkles',
        festiveDecorations: 'lebaran'
    },
    tahun_baru: {
        id: 'tahun_baru',
        name: 'Tahun Baru (New Year)',
        subtitle: 'Nuansa Emas Kemilau & Midnight Sparkle',
        accentColor: '#f59e0b',
        secondaryColor: '#ec4899',
        glowColor: 'rgba(245, 158, 11, 0.35)',
        badgeText: '🎉 Happy New Year',
        bannerTitle: 'Selamat Tahun Baru',
        bannerSubtitle: 'Sambut lembaran tahun baru dengan irama musik penuh semangat, inspirasi, dan harapan gemilang.',
        icon: 'party-popper',
        festiveDecorations: 'tahun_baru'
    },
    idul_adha: {
        id: 'idul_adha',
        name: 'Hari Raya Idul Adha (Qurban)',
        subtitle: 'Nuansa Berkah Zaitun & Emas Padang Pasir',
        accentColor: '#84cc16',
        secondaryColor: '#d97706',
        glowColor: 'rgba(132, 204, 22, 0.3)',
        badgeText: '🕋 Idul Adha & Qurban',
        bannerTitle: 'Hari Raya Idul Adha',
        bannerSubtitle: 'Semoga semangat pengorbanan dan keikhlasan membawa limpahan berkah, kebersamaan, dan kedamaian.',
        icon: 'heart-handshake',
        festiveDecorations: 'idul_adha'
    }
};

function getStoredTheme() {
    const defaultData = {
        activeTheme: 'default',
        showBanner: true,
        customGreeting: '',
        updatedAt: new Date().toISOString()
    };

    const stored = storage.readData(THEME_FILE, defaultData);
    if (stored && stored.activeTheme && THEMES[stored.activeTheme]) {
        return {
            activeTheme: stored.activeTheme,
            showBanner: stored.showBanner !== false,
            customGreeting: stored.customGreeting || '',
            updatedAt: stored.updatedAt || defaultData.updatedAt
        };
    }
    return defaultData;
}

function saveTheme(config) {
    return storage.writeData(THEME_FILE, config);
}

module.exports = function (req, res) {
    res.setHeader('Content-Type', 'application/json');
    const method = req.method.toUpperCase();

    // GET /api/theme - Public theme config
    if (method === 'GET') {
        const current = getStoredTheme();
        const themeInfo = THEMES[current.activeTheme] || THEMES.default;

        return res.json({
            status: true,
            activeTheme: current.activeTheme,
            showBanner: current.showBanner,
            customGreeting: current.customGreeting,
            updatedAt: current.updatedAt,
            themeDetails: themeInfo,
            availableThemes: Object.values(THEMES)
        });
    }

    // POST /api/theme - Admin updates theme
    if (method === 'POST') {
        const token = req.headers['x-admin-token'] || req.query.token;
        if (!adminAuth.isValidToken(token)) {
            return res.status(401).json({ status: false, message: 'Akses ditolak: Membutuhkan token admin' });
        }

        const body = req.body || {};
        const requestedTheme = body.themeId || body.activeTheme || 'default';

        if (!THEMES[requestedTheme]) {
            return res.status(400).json({ status: false, message: 'Tema musiman tidak valid: ' + requestedTheme });
        }

        const newConfig = {
            activeTheme: requestedTheme,
            showBanner: body.showBanner !== false,
            customGreeting: typeof body.customGreeting === 'string' ? body.customGreeting.trim() : '',
            updatedAt: new Date().toISOString()
        };

        const success = saveTheme(newConfig);
        if (!success) {
            return res.status(500).json({ status: false, message: 'Gagal menyimpan tema musiman' });
        }

        return res.json({
            status: true,
            success: true,
            activeTheme: requestedTheme,
            message: `Tema musiman "${THEMES[requestedTheme].name}" berhasil diaktifkan!`,
            config: newConfig,
            themeDetails: THEMES[requestedTheme]
        });
    }

    return res.status(405).json({ status: false, message: 'Metode tidak didukung' });
};

module.exports.getStoredTheme = getStoredTheme;
module.exports.THEMES = THEMES;
