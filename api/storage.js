const fs = require('fs');
const path = require('path');
const os = require('os');

// In-memory store to keep state across serverless function invocations within the same container
const memoryStore = new Map();

function getFilePaths(filename) {
    const baseName = path.basename(filename);
    const standardDataDir = path.join(__dirname, '..', 'data');
    const standardRootPath = path.join(standardDataDir, baseName);

    const tmpStandardDir = path.join(os.tmpdir(), 'data');
    const tmpStandardPath = path.join(tmpStandardDir, baseName);

    return { standardDataDir, tmpStandardDir, standardRootPath, tmpStandardPath, key: baseName };
}

function readData(filename, defaultValue) {
    const { standardRootPath, tmpStandardPath, key } = getFilePaths(filename);

    // Pick the most recently updated file between project disk and /tmp disk
    let latestPath = null;
    let latestMtime = -1;

    const checkPaths = [standardRootPath, tmpStandardPath];
    for (const p of checkPaths) {
        try {
            if (fs.existsSync(p)) {
                const stat = fs.statSync(p);
                if (stat.mtimeMs > latestMtime) {
                    latestMtime = stat.mtimeMs;
                    latestPath = p;
                }
            }
        } catch (e) {}
    }

    if (latestPath) {
        try {
            const raw = fs.readFileSync(latestPath, 'utf8');
            const parsed = JSON.parse(raw);
            memoryStore.set(key, parsed);
            return parsed;
        } catch (e) {}
    }

    if (memoryStore.has(key)) {
        return memoryStore.get(key);
    }

    const fallback = defaultValue !== undefined ? defaultValue : null;
    if (fallback !== null) {
        memoryStore.set(key, fallback);
    }
    return fallback;
}

function writeData(filename, data) {
    const { standardDataDir, tmpStandardDir, standardRootPath, tmpStandardPath, key } = getFilePaths(filename);

    // 1. Update in-memory state
    memoryStore.set(key, data);

    const jsonStr = JSON.stringify(data, null, 2);

    // 2. Write to unified single project directory: /data
    try {
        if (!fs.existsSync(standardDataDir)) {
            fs.mkdirSync(standardDataDir, { recursive: true });
        }
        fs.writeFileSync(standardRootPath, jsonStr, 'utf8');
    } catch (e) {}

    // 3. Write to /tmp/data (ensures persistence in serverless environments)
    try {
        if (!fs.existsSync(tmpStandardDir)) {
            fs.mkdirSync(tmpStandardDir, { recursive: true });
        }
        fs.writeFileSync(tmpStandardPath, jsonStr, 'utf8');
    } catch (e) {}

    return true;
}

module.exports = {
    readData,
    writeData,
    getFilePaths
};
