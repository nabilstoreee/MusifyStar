const fs = require('fs');
const path = require('path');
const os = require('os');

// In-memory store to keep state across serverless function invocations within the same container
const memoryStore = new Map();

function getFilePaths(filename) {
    const baseName = path.basename(filename);
    const dataDir = path.join(__dirname, '..', 'data json');
    const rootPath = path.join(dataDir, baseName);
    const legacyRootPath = path.join(__dirname, '..', baseName);

    const tmpDataDir = path.join(os.tmpdir(), 'data json');
    const tmpPath = path.join(tmpDataDir, baseName);
    const legacyTmpPath = path.join(os.tmpdir(), baseName);

    return { dataDir, tmpDataDir, rootPath, legacyRootPath, tmpPath, legacyTmpPath, key: baseName };
}

function readData(filename, defaultValue) {
    const { rootPath, legacyRootPath, tmpPath, legacyTmpPath, key } = getFilePaths(filename);

    // Check disk first: /tmp/data json, /tmp, project 'data json', project root
    const checkPaths = [tmpPath, legacyTmpPath, rootPath, legacyRootPath];
    for (const p of checkPaths) {
        try {
            if (fs.existsSync(p)) {
                const raw = fs.readFileSync(p, 'utf8');
                const parsed = JSON.parse(raw);
                memoryStore.set(key, parsed);
                return parsed;
            }
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
    const { dataDir, tmpDataDir, rootPath, tmpPath, key } = getFilePaths(filename);

    // 1. Update in-memory state
    memoryStore.set(key, data);

    const jsonStr = JSON.stringify(data, null, 2);

    // 2. Try writing to 'data json' directory in project
    try {
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        fs.writeFileSync(rootPath, jsonStr, 'utf8');
    } catch (e) {
        // Expected on Vercel/Serverless (EROFS: read-only file system)
    }

    // 3. Try writing to /tmp/data json (always writable in AWS Lambda / Vercel Serverless)
    try {
        if (!fs.existsSync(tmpDataDir)) {
            fs.mkdirSync(tmpDataDir, { recursive: true });
        }
        fs.writeFileSync(tmpPath, jsonStr, 'utf8');
    } catch (e) {}

    return true;
}

module.exports = {
    readData,
    writeData,
    getFilePaths
};
