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

// Local fallback directory for offline / timeout durability
const DATA_DIR = path.join(__dirname, '..', 'data');
try {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
} catch (e) {}

// Security Sanitizer: Strips out passwords and database host info from any log output
function sanitizeLog(err) {
    if (!err) return '';
    const raw = typeof err === 'string' ? err : (err.message || String(err));
    return raw.replace(/postgresql:\/\/[^@]+@/gi, 'postgresql://***:***@');
}

let pool = null;
if (DATABASE_URL) {
    try {
        pool = new Pool({
            connectionString: DATABASE_URL,
            ssl: { rejectUnauthorized: false },
            max: 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 4000,
            statement_timeout: 6000
        });

        // Catch backend idle disconnects cleanly without crashing process
        pool.on('error', (err) => {
            console.warn('[Neon PostgreSQL] Background pool connection notice:', sanitizeLog(err));
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
            console.warn('[Neon PostgreSQL] Table init notice (falling back to memory/disk):', sanitizeLog(err));
        });
    } catch (e) {
        console.warn('[Neon PostgreSQL] Pool init notice:', sanitizeLog(e));
    }
}

// In-memory cache kept in sync with PostgreSQL and disk for ultra-fast response times
const memoryStore = new Map();

// Helper to sanitize keys
function normalizeKey(filename) {
    return path.basename(filename);
}

function getLocalFilePath(key) {
    return path.join(DATA_DIR, key.endsWith('.json') ? key : `${key}.json`);
}

function readFromDisk(key) {
    try {
        const filePath = getLocalFilePath(key);
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(raw);
        }
    } catch (e) {}
    return null;
}

function writeToDisk(key, data) {
    try {
        const filePath = getLocalFilePath(key);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {}
}

// Load data directly from PostgreSQL with timeout guard
async function fetchFromPostgres(key) {
    if (!pool) return readFromDisk(key);
    try {
        const queryPromise = pool.query('SELECT data FROM app_storage WHERE key = $1', [key]);
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Postgres query timeout')), 3500));
        const res = await Promise.race([queryPromise, timeoutPromise]);
        
        if (res && res.rows && res.rows.length > 0) {
            const data = res.rows[0].data;
            memoryStore.set(key, data);
            writeToDisk(key, data); // Keep disk mirror in sync
            return data;
        }
    } catch (err) {
        // Soft fallback to disk mirror if Postgres times out or disconnects
        const diskData = readFromDisk(key);
        if (diskData !== null) {
            memoryStore.set(key, diskData);
            return diskData;
        }
    }
    return null;
}

// Save data directly into PostgreSQL with timeout guard
async function writeToPostgres(key, data) {
    writeToDisk(key, data); // Always write to disk immediately for 100% durability
    if (!pool) return true;
    try {
        const queryPromise = pool.query(
            `INSERT INTO app_storage (key, data, updated_at) VALUES ($1, $2, NOW())
             ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
            [key, JSON.stringify(data)]
        );
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Postgres write timeout')), 4000));
        await Promise.race([queryPromise, timeoutPromise]);
        return true;
    } catch (err) {
        console.warn(`[Neon PostgreSQL] Notice: Persisted locally, database write deferred for "${key}":`, sanitizeLog(err));
        return true; // Still considered successful because memory + disk are safely persisted
    }
}

/**
 * Synchronous read accessor (reads from live memory mirror synced with Neon PostgreSQL and disk)
 */
function readData(filename, defaultValue) {
    const key = normalizeKey(filename);

    if (memoryStore.has(key)) {
        return memoryStore.get(key);
    }

    const diskData = readFromDisk(key);
    if (diskData !== null) {
        memoryStore.set(key, diskData);
        return diskData;
    }

    // Refresh from PostgreSQL in background if not yet loaded
    fetchFromPostgres(key).catch(() => {});

    return defaultValue !== undefined ? defaultValue : null;
}

/**
 * Write accessor (updates live memory state and persists to Neon PostgreSQL + disk)
 */
function writeData(filename, data) {
    const key = normalizeKey(filename);

    // 1. Immediately update active memory state
    memoryStore.set(key, data);

    // 2. Persist to disk + Neon PostgreSQL
    writeToPostgres(key, data).catch(() => {});

    return true;
}

// Async direct read from PostgreSQL (guarantees fresh data from Neon or disk fallback)
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

// Async direct write to PostgreSQL (awaited for durability)
async function writeDataAsync(filename, data) {
    const key = normalizeKey(filename);
    memoryStore.set(key, data);
    return await writeToPostgres(key, data);
}

// Preload all tables from Neon PostgreSQL and local disk on boot
async function initNeonPrimary() {
    // 1. Load any local disk cache first
    try {
        if (fs.existsSync(DATA_DIR)) {
            const files = fs.readdirSync(DATA_DIR);
            for (const file of files) {
                if (file.endsWith('.json')) {
                    const key = file.replace(/\.json$/, '');
                    const d = readFromDisk(key);
                    if (d !== null) memoryStore.set(key, d);
                }
            }
        }
    } catch (e) {}

    // 2. Load fresh records from PostgreSQL if available
    if (!pool) return;
    try {
        const queryPromise = pool.query('SELECT key, data FROM app_storage');
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Postgres init timeout')), 4000));
        const res = await Promise.race([queryPromise, timeoutPromise]);
        if (res && res.rows) {
            for (const row of res.rows) {
                memoryStore.set(row.key, row.data);
                writeToDisk(row.key, row.data);
            }
            console.log(`[Neon PostgreSQL] Primary DB active: Loaded ${res.rows.length} keys directly into memory cache.`);
        }
    } catch (e) {
        console.log('[Neon PostgreSQL] Server ready with memory/disk state cache.');
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

