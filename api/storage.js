const fs = require('fs');
const path = require('path');
const os = require('os');

// In-memory store to keep state across serverless function invocations within the same container
const memoryStore = new Map();

function getFilePaths(filename) {
    const baseName = path.basename(filename);
    const rootPath = path.join(__dirname, '..', baseName);
    const tmpPath = path.join(os.tmpdir(), baseName);
    return { rootPath, tmpPath, key: baseName };
}

function readData(filename, defaultValue) {
    const { rootPath, tmpPath, key } = getFilePaths(filename);

    if (memoryStore.has(key)) {
        return memoryStore.get(key);
    }

    // Check /tmp first (holds latest runtime updates in serverless)
    try {
        if (fs.existsSync(tmpPath)) {
            const raw = fs.readFileSync(tmpPath, 'utf8');
            const parsed = JSON.parse(raw);
            memoryStore.set(key, parsed);
            return parsed;
        }
    } catch (e) {}

    // Check project root (initial pre-packaged config)
    try {
        if (fs.existsSync(rootPath)) {
            const raw = fs.readFileSync(rootPath, 'utf8');
            const parsed = JSON.parse(raw);
            memoryStore.set(key, parsed);
            return parsed;
        }
    } catch (e) {}

    const fallback = defaultValue !== undefined ? defaultValue : null;
    if (fallback !== null) {
        memoryStore.set(key, fallback);
    }
    return fallback;
}

function writeData(filename, data) {
    const { rootPath, tmpPath, key } = getFilePaths(filename);

    // 1. Update in-memory state
    memoryStore.set(key, data);

    const jsonStr = JSON.stringify(data, null, 2);
    let written = false;

    // 2. Try writing to root path (works in container/local)
    try {
        fs.writeFileSync(rootPath, jsonStr, 'utf8');
        written = true;
    } catch (e) {
        // Expected on Vercel/Serverless (EROFS: read-only file system)
    }

    // 3. Try writing to /tmp (always writable in AWS Lambda / Vercel Serverless)
    try {
        fs.writeFileSync(tmpPath, jsonStr, 'utf8');
        written = true;
    } catch (e) {}

    return true;
}

module.exports = {
    readData,
    writeData,
    getFilePaths
};
