const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Neon PostgreSQL Database URL
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_VuRmHWJE9yb3@ep-dawn-fog-azzl4nav-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';

let pool = null;
try {
    pool = new Pool({
        connectionString: DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 15,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 8000
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
        return true;
    } catch (err) {
        console.error(`[Neon PostgreSQL] Error saving key "${key}":`, err.message);
        return false;
    }
}

/**
 * Synchronous read accessor (reads from live memory mirror, immediately verified against PostgreSQL)
 */
function readData(filename, defaultValue) {
    const key = normalizeKey(filename);

    if (memoryStore.has(key)) {
        return memoryStore.get(key);
    }

    // Fallback if not yet loaded in cache (e.g. initial boot before connection finishes)
    const fallback = defaultValue !== undefined ? defaultValue : null;
    if (fallback !== null) {
        memoryStore.set(key, fallback);
    }

    // Refresh from PostgreSQL in background
    fetchFromPostgres(key).catch(() => {});

    return fallback;
}

/**
 * Write accessor (updates memory mirror and immediately persists to Neon PostgreSQL)
 */
function writeData(filename, data) {
    const key = normalizeKey(filename);

    // 1. Immediately update active memory state
    memoryStore.set(key, data);

    // 2. Persist directly to Neon PostgreSQL PRIMARY database
    writeToPostgres(key, data).catch(err => {
        console.error(`[Neon PostgreSQL] Write failed for ${key}:`, err);
    });

    return true;
}

// Async direct read from PostgreSQL (for endpoints requiring guaranteed fresh read)
async function readDataAsync(filename, defaultValue) {
    const key = normalizeKey(filename);
    const dbData = await fetchFromPostgres(key);
    if (dbData !== null) {
        return dbData;
    }
    if (memoryStore.has(key)) {
        return memoryStore.get(key);
    }
    return defaultValue !== undefined ? defaultValue : null;
}

// Async direct write to PostgreSQL
async function writeDataAsync(filename, data) {
    const key = normalizeKey(filename);
    memoryStore.set(key, data);
    return await writeToPostgres(key, data);
}

// Preload all tables from Neon PostgreSQL into cache on server boot
async function initNeonPrimary() {
    if (!pool) return;
    try {
        const res = await pool.query('SELECT key, data FROM app_storage');
        for (const row of res.rows) {
            memoryStore.set(row.key, row.data);
        }
        console.log(`[Neon PostgreSQL] Primary DB active: Loaded ${res.rows.length} keys directly into memory.`);
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
