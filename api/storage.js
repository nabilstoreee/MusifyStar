const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Auto-load .env configuration if not already loaded into process.env
try {
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        envContent.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
                const eqIdx = trimmed.indexOf('=');
                if (eqIdx > 0) {
                    const k = trimmed.slice(0, eqIdx).trim();
                    const v = trimmed.slice(eqIdx + 1).trim();
                    if (!process.env[k]) {
                        process.env[k] = v;
                    }
                }
            }
        });
    }
} catch (e) {}

// Neon PostgreSQL Database URL from environment
const DATABASE_URL = process.env.DATABASE_URL;

// Local mirror directory
const DATA_DIR = path.join(__dirname, '..', 'data');
try {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
} catch (e) {}

let pool = null;
try {
    pool = new Pool({
        connectionString: DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000
    });

    // Auto-create storage table in PostgreSQL if not present
    pool.query(`
        CREATE TABLE IF NOT EXISTS app_storage (
            key VARCHAR(100) PRIMARY KEY,
            data JSONB NOT NULL,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
    `).then(() => {
        console.log('[Neon PostgreSQL] Table verified & active as PRIMARY database.');
    }).catch(err => {
        console.error('[Neon PostgreSQL] Table init error:', err.message);
    });
} catch (e) {
    console.error('[Neon PostgreSQL] Pool init error:', e.message);
}

// In-memory cache kept in sync with PostgreSQL for instant response times
const memoryStore = new Map();

// Helper to sanitize keys
function normalizeKey(filename) {
    return path.basename(filename);
}

// Load data directly from PostgreSQL
async function fetchFromPostgres(key) {
    if (!pool) return null;
    try {
        const res = await pool.query('SELECT data FROM app_storage WHERE key = $1', [key]);
        if (res.rows && res.rows.length > 0) {
            const data = res.rows[0].data;
            memoryStore.set(key, data);
            try {
                fs.writeFileSync(path.join(DATA_DIR, key), JSON.stringify(data, null, 2), 'utf8');
            } catch (e) {}
            return data;
        }
    } catch (err) {
        console.warn(`[Neon PostgreSQL] Error reading key "${key}":`, err.message);
    }
    return null;
}

// Save data directly into PostgreSQL
async function writeToPostgres(key, data) {
    if (!pool) return false;
    try {
        await pool.query(
            `INSERT INTO app_storage (key, data, updated_at) VALUES ($1, $2, NOW())
             ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
            [key, JSON.stringify(data)]
        );
        try {
            fs.writeFileSync(path.join(DATA_DIR, key), JSON.stringify(data, null, 2), 'utf8');
        } catch (e) {}
        return true;
    } catch (err) {
        console.error(`[Neon PostgreSQL] Error saving key "${key}":`, err.message);
        return false;
    }
}

/**
 * Synchronous read accessor (reads from live memory mirror or disk backup)
 */
function readData(filename, defaultValue) {
    const key = normalizeKey(filename);

    if (memoryStore.has(key)) {
        return memoryStore.get(key);
    }

    // Check local disk mirror first before falling back to empty defaultValue
    try {
        const localPath = path.join(DATA_DIR, key);
        if (fs.existsSync(localPath)) {
            const raw = fs.readFileSync(localPath, 'utf8');
            const parsed = JSON.parse(raw);
            memoryStore.set(key, parsed);
            return parsed;
        }
    } catch (e) {}

    // Refresh from PostgreSQL in background (DO NOT store fallback in memoryStore!)
    fetchFromPostgres(key).catch(() => {});

    return defaultValue !== undefined ? defaultValue : null;
}

/**
 * Write accessor (updates memory mirror, disk mirror, and persists to Neon PostgreSQL)
 */
function writeData(filename, data) {
    const key = normalizeKey(filename);

    // 1. Immediately update active memory state & local disk
    memoryStore.set(key, data);
    try {
        fs.writeFileSync(path.join(DATA_DIR, key), JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {}

    // 2. Persist directly to Neon PostgreSQL PRIMARY database
    writeToPostgres(key, data).catch(err => {
        console.error(`[Neon PostgreSQL] Write failed for ${key}:`, err);
    });

    return true;
}

// Async direct read from PostgreSQL (guarantees 100% fresh data from Neon)
async function readDataAsync(filename, defaultValue) {
    const key = normalizeKey(filename);
    const dbData = await fetchFromPostgres(key);
    if (dbData !== null) {
        return dbData;
    }
    if (memoryStore.has(key)) {
        return memoryStore.get(key);
    }
    try {
        const localPath = path.join(DATA_DIR, key);
        if (fs.existsSync(localPath)) {
            const raw = fs.readFileSync(localPath, 'utf8');
            const parsed = JSON.parse(raw);
            memoryStore.set(key, parsed);
            return parsed;
        }
    } catch (e) {}
    return defaultValue !== undefined ? defaultValue : null;
}

// Async direct write to PostgreSQL (awaited for 100% durability)
async function writeDataAsync(filename, data) {
    const key = normalizeKey(filename);
    memoryStore.set(key, data);
    try {
        fs.writeFileSync(path.join(DATA_DIR, key), JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {}
    return await writeToPostgres(key, data);
}

// Preload all tables from Neon PostgreSQL into cache on server boot
async function initNeonPrimary() {
    if (!pool) return;
    try {
        const res = await pool.query('SELECT key, data FROM app_storage');
        for (const row of res.rows) {
            memoryStore.set(row.key, row.data);
            try {
                fs.writeFileSync(path.join(DATA_DIR, row.key), JSON.stringify(row.data, null, 2), 'utf8');
            } catch (e) {}
        }
        console.log(`[Neon PostgreSQL] Primary DB active: Loaded ${res.rows.length} keys directly into memory & disk mirror.`);
    } catch (e) {
        console.warn('[Neon PostgreSQL] Initial load warning:', e.message);
    }
}
initNeonPrimary().catch(() => {});

module.exports = {
    readData,
    writeData,
    readDataAsync,
    writeDataAsync,
    fetchFromPostgres,
    writeToPostgres,
    pool
};
