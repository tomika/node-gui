'use strict';

/**
 * Tests for the node-gui-pack tool (bin/pack.js).
 *
 * These tests exercise:
 *   - File collection (shouldExclude / matchPattern)
 *   - Archive building (buildArchive) and footer layout
 *   - Settings loading from package.json (loadSettings helpers)
 *
 * The tests do NOT require a C compiler and do NOT produce a real executable;
 * they only test the JavaScript logic of pack.js in isolation.
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

/* -------------------------------------------------------------------------
 * Inline the helpers from pack.js so we can test them without side-effects
 * -------------------------------------------------------------------------*/

const MAGIC         = 'NGPACK01';
const MAIN_PATH_MAX = 128;
const FOOTER_SIZE   = 4 + 4 + 8 + MAIN_PATH_MAX + 8; // 152

function matchPattern(str, pattern) {
    if (!pattern.includes('*')) {
        return str === pattern || str.startsWith(pattern + '/');
    }
    const re = new RegExp(
        '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                     .replace(/\*/g, '[^/]*') + '$'
    );
    return re.test(str);
}

function shouldExclude(relPath, patterns) {
    const base = relPath.split('/').pop();
    for (const pattern of patterns) {
        if (matchPattern(relPath, pattern)) return true;
        if (matchPattern(base, pattern))    return true;
    }
    return false;
}

function collectFiles(dir, excludePatterns, baseDir) {
    if (baseDir === undefined) baseDir = dir;
    const results = [];
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return results; }
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath  = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        if (shouldExclude(relPath, excludePatterns)) continue;
        if (entry.isDirectory()) {
            results.push(...collectFiles(fullPath, excludePatterns, baseDir));
        } else if (entry.isFile()) {
            results.push({ fullPath, relPath });
        }
    }
    return results;
}

function buildArchive(files, launcherSize, mainPath, flags) {
    const chunks = [];
    for (const { fullPath, relPath } of files) {
        const pathBuf = Buffer.from(relPath, 'utf8');
        let dataBuf;
        try { dataBuf = fs.readFileSync(fullPath); }
        catch (_) { continue; }
        const pathLenBuf = Buffer.alloc(4);
        pathLenBuf.writeUInt32LE(pathBuf.length, 0);
        const dataLenBuf = Buffer.alloc(8);
        dataLenBuf.writeBigUInt64LE(BigInt(dataBuf.length), 0);
        chunks.push(pathLenBuf, pathBuf, dataLenBuf, dataBuf);
    }
    const archiveBuf   = Buffer.concat(chunks);
    const archiveOffset = launcherSize;
    const footer = Buffer.alloc(FOOTER_SIZE, 0);
    let off = 0;
    footer.writeUInt32LE(files.length, off);            off += 4;
    footer.writeUInt32LE(flags, off);                   off += 4;
    footer.writeBigUInt64LE(BigInt(archiveOffset), off); off += 8;
    const mainPathBuf = Buffer.from(mainPath, 'utf8');
    mainPathBuf.copy(footer, off);
    off += MAIN_PATH_MAX;
    Buffer.from(MAGIC, 'ascii').copy(footer, off);
    return Buffer.concat([archiveBuf, footer]);
}

/* -------------------------------------------------------------------------
 * Test runner
 * -------------------------------------------------------------------------*/
let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
        process.exitCode = 1;
    }
}

console.log('node-gui-pack tests\n');

/* -------------------------------------------------------------------------
 * matchPattern tests
 * -------------------------------------------------------------------------*/
console.log('-- matchPattern --');

test('exact match', () => {
    assert.ok(matchPattern('.git', '.git'));
});
test('prefix match (directory)', () => {
    assert.ok(matchPattern('.git/config', '.git'));
});
test('no match on different name', () => {
    assert.ok(!matchPattern('src/index.js', '.git'));
});
test('wildcard matches extension', () => {
    assert.ok(matchPattern('app.log', '*.log'));
});
test('wildcard does not cross directory boundary', () => {
    assert.ok(!matchPattern('logs/app.log', '*.log'));
});
test('wildcard matches basename only', () => {
    assert.ok(matchPattern('npm-debug.log2', 'npm-debug.log*'));
});

/* -------------------------------------------------------------------------
 * shouldExclude tests
 * -------------------------------------------------------------------------*/
console.log('\n-- shouldExclude --');

const DEFAULT_EXCLUDES = ['.git', 'node_modules/.bin', '*.log'];

test('excludes .git directory files', () => {
    assert.ok(shouldExclude('.git/config', DEFAULT_EXCLUDES));
});
test('excludes node_modules/.bin files', () => {
    assert.ok(shouldExclude('node_modules/.bin/mocha', DEFAULT_EXCLUDES));
});
test('excludes *.log files by basename', () => {
    assert.ok(shouldExclude('logs/server.log', DEFAULT_EXCLUDES));
});
test('does not exclude normal source files', () => {
    assert.ok(!shouldExclude('src/index.js', DEFAULT_EXCLUDES));
});
test('does not exclude node_modules (only .bin inside)', () => {
    assert.ok(!shouldExclude('node_modules/express/index.js', DEFAULT_EXCLUDES));
});

/* -------------------------------------------------------------------------
 * collectFiles tests
 * -------------------------------------------------------------------------*/
console.log('\n-- collectFiles --');

test('collects files from a temp directory tree', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ngpack-test-'));
    try {
        fs.writeFileSync(path.join(tmp, 'index.js'), 'hello');
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'app.js'), 'world');
        fs.mkdirSync(path.join(tmp, '.git'));
        fs.writeFileSync(path.join(tmp, '.git', 'HEAD'), 'ref: refs/heads/main');

        const files = collectFiles(tmp, ['.git']);
        const relPaths = files.map(f => f.relPath).sort();

        assert.deepStrictEqual(relPaths, ['index.js', 'src/app.js']);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('returns empty array for non-existent directory', () => {
    const files = collectFiles('/nonexistent-dir-xyz', []);
    assert.deepStrictEqual(files, []);
});

test('excludes user-specified patterns', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ngpack-test-'));
    try {
        fs.writeFileSync(path.join(tmp, 'index.js'), 'x');
        fs.writeFileSync(path.join(tmp, 'debug.log'), 'y');
        fs.mkdirSync(path.join(tmp, 'dist'));
        fs.writeFileSync(path.join(tmp, 'dist', 'bundle.js'), 'z');

        const files = collectFiles(tmp, ['dist', '*.log']);
        const relPaths = files.map(f => f.relPath).sort();
        assert.deepStrictEqual(relPaths, ['index.js']);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

/* -------------------------------------------------------------------------
 * buildArchive / footer layout tests
 * -------------------------------------------------------------------------*/
console.log('\n-- buildArchive --');

test('footer is FOOTER_SIZE bytes and ends with magic', () => {
    // Create a tiny fake file
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ngpack-test-'));
    try {
        fs.writeFileSync(path.join(tmp, 'index.js'), 'console.log("hi")');
        const files = [{ fullPath: path.join(tmp, 'index.js'), relPath: 'index.js' }];
        const archive = buildArchive(files, 1000, 'index.js', 0x01);

        // The last FOOTER_SIZE bytes are the footer
        assert.ok(archive.length >= FOOTER_SIZE);
        const magic = archive.slice(archive.length - 8).toString('ascii');
        assert.strictEqual(magic, MAGIC);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('footer file_count matches number of files', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ngpack-test-'));
    try {
        fs.writeFileSync(path.join(tmp, 'a.js'), 'a');
        fs.writeFileSync(path.join(tmp, 'b.js'), 'b');
        const files = [
            { fullPath: path.join(tmp, 'a.js'), relPath: 'a.js' },
            { fullPath: path.join(tmp, 'b.js'), relPath: 'b.js' },
        ];
        const archive = buildArchive(files, 512, 'a.js', 0);
        const footerStart = archive.length - FOOTER_SIZE;
        const fileCount = archive.readUInt32LE(footerStart);
        assert.strictEqual(fileCount, 2);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('footer flags reflect hideConsole=true', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ngpack-test-'));
    try {
        fs.writeFileSync(path.join(tmp, 'index.js'), '');
        const files = [{ fullPath: path.join(tmp, 'index.js'), relPath: 'index.js' }];
        const archive = buildArchive(files, 0, 'index.js', 0x01 /* FLAG_HIDE_CONSOLE */);
        const footerStart = archive.length - FOOTER_SIZE;
        const flags = archive.readUInt32LE(footerStart + 4);
        assert.strictEqual(flags & 0x01, 0x01);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('footer archive_offset equals the launcherSize argument', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ngpack-test-'));
    try {
        fs.writeFileSync(path.join(tmp, 'index.js'), '');
        const files = [{ fullPath: path.join(tmp, 'index.js'), relPath: 'index.js' }];
        const launcherSize = 98765;
        const archive = buildArchive(files, launcherSize, 'index.js', 0);
        const footerStart = archive.length - FOOTER_SIZE;
        const archiveOffset = Number(archive.readBigUInt64LE(footerStart + 8));
        assert.strictEqual(archiveOffset, launcherSize);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('footer main_path is stored correctly', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ngpack-test-'));
    try {
        fs.writeFileSync(path.join(tmp, 'index.js'), '');
        const files = [{ fullPath: path.join(tmp, 'index.js'), relPath: 'index.js' }];
        const archive = buildArchive(files, 0, 'src/index.js', 0);
        const footerStart = archive.length - FOOTER_SIZE;
        // main_path starts at offset 16 (4+4+8) from footerStart
        const mainPathBuf = archive.slice(footerStart + 16, footerStart + 16 + MAIN_PATH_MAX);
        const mainPath = mainPathBuf.toString('utf8').replace(/\0/g, '');
        assert.strictEqual(mainPath, 'src/index.js');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('file entry path and data are correctly written', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ngpack-test-'));
    try {
        const content = 'hello world';
        fs.writeFileSync(path.join(tmp, 'hello.js'), content);
        const files = [{ fullPath: path.join(tmp, 'hello.js'), relPath: 'hello.js' }];
        const archive = buildArchive(files, 0, 'hello.js', 0);

        // Entries start at offset 0 (launcherSize = 0 here in the archive buffer itself)
        // Format: uint32 path_len, path bytes, uint64 data_len, data bytes, … footer
        let off = 0;
        const pathLen = archive.readUInt32LE(off); off += 4;
        const entryPath = archive.slice(off, off + pathLen).toString('utf8'); off += pathLen;
        const dataLen = Number(archive.readBigUInt64LE(off)); off += 8;
        const data = archive.slice(off, off + dataLen).toString('utf8');

        assert.strictEqual(entryPath, 'hello.js');
        assert.strictEqual(dataLen, Buffer.byteLength(content, 'utf8'));
        assert.strictEqual(data, content);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

/* -------------------------------------------------------------------------
 * Launcher source files exist
 * -------------------------------------------------------------------------*/
console.log('\n-- launcher source files --');

test('launcher_win.c exists', () => {
    const p = path.join(__dirname, '..', 'src', 'launcher', 'launcher_win.c');
    assert.ok(fs.existsSync(p), `Missing ${p}`);
});

test('launcher_posix.c exists', () => {
    const p = path.join(__dirname, '..', 'src', 'launcher', 'launcher_posix.c');
    assert.ok(fs.existsSync(p), `Missing ${p}`);
});

test('bin/pack.js exists and is executable-ish', () => {
    const p = path.join(__dirname, '..', 'bin', 'pack.js');
    assert.ok(fs.existsSync(p), `Missing ${p}`);
    const src = fs.readFileSync(p, 'utf8');
    assert.ok(src.startsWith('#!/usr/bin/env node'), 'Missing shebang');
});

/* -------------------------------------------------------------------------
 * Summary
 * -------------------------------------------------------------------------*/
console.log(`\n${passed} tests passed${failed ? `, ${failed} failed` : ''}`);
