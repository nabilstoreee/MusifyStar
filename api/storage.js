const fs = require('fs');
const path = require('path');
const os = require('os');

// In-memory store to keep state across serverless function invocations within the same container
const memoryStore = new Map();

function getFilePaths(filename) {
    const baseName = path.basename(filename);
    const dataDir = path.join(__dirname, '..', 'data json');
    const rootPath = path.join(dataDir, baseName);
    const standardDataDir = path.join(__dirname, '..', 'data');
    const standardRootPath = path.join(standardDataDir, baseName);
    const legacyRootPath = path.join(__dirname, '..', baseName);

    const tmpDataDir = path.join(os.tmpdir(), 'data json');
    const tmpPath = path.join(tmpDataDir, baseName);
    const tmpStandardDir = path.join(os.tmpdir(), 'data');
    const tmpStandardPath = path.join(tmpStandardDir, baseName);
    const legacyTmpPath = path.join(os.tmpdir(), baseName);

    return { dataDir, standardDataDir, tmpDataDir, tmpStandardDir, rootPath, standardRootPath, legacyRootPath, tmpPath, tmpStandardPath, legacyTmpPath, key: baseName };
}

function readData(filename, defaultValue) {
    const { rootPath, standardRootPath, legacyRootPath, tmpPath, tmpStandardPath, legacyTmpPath, key } = getFilePaths(filename);

    // Check disk first: /tmp/data json, /tmp/data, /tmp, project 'data json', project 'data', project root
    const checkPaths = [tmpPath, tmpStandardPath, legacyTmpPath, rootPath, standardRootPath, legacyRootPath];
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
    const { dataDir, standardDataDir, tmpDataDir, tmpStandardDir, rootPath, standardRootPath, tmpPath, tmpStandardPath, key } = getFilePaths(filename);

    // 1. Update in-memory state
    memoryStore.set(key, data);

    const jsonStr = JSON.stringify(data, null, 2);

    // 2. Try writing to project directories (for local dev environments)
    try {
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        fs.writeFileSync(rootPath, jsonStr, 'utf8');
    } catch (e) {}

    try {
        if (!fs.existsSync(standardDataDir)) {
            fs.mkdirSync(standardDataDir, { recursive: true });
        }
        fs.writeFileSync(standardRootPath, jsonStr, 'utf8');
    } catch (e) {}

    // 3. Try writing to /tmp directories (always writable on Vercel Serverless / AWS Lambda)
    try {
        if (!fs.existsSync(tmpDataDir)) {
            fs.mkdirSync(tmpDataDir, { recursive: true });
        }
        fs.writeFileSync(tmpPath, jsonStr, 'utf8');
    } catch (e) {}

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
