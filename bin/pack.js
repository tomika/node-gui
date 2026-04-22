#!/usr/bin/env node
'use strict';

/**
 * node-gui-pack – Bundle a Node.js project that uses node-gui into a single
 * native executable.
 *
 * Usage:
 *   npx node-gui-pack
 *   npx node-gui-pack /path/to/project
 *   npx node-gui-pack --entry src/main.js
 *
 * Configuration is read from the project's package.json under the
 * "node-gui" → "pack" key:
 *
 *   {
 *     "node-gui": {
 *       "pack": {
 *         "output":       "dist/myapp",         // output path (no extension)
 *         "main":         "src/index.js",        // entry-point (falls back to pkg.main)
 *         "hideConsole":  true,                  // Windows: hide console window (default true)
 *         "icon":         "assets/icon.svg",     // path to SVG/PNG/JPG/ICO icon file
 *         "exclude":      [".git", "dist"]       // extra exclude patterns
 *       }
 *     }
 *   }
 *
 * Pack format:
 *   The output file is laid out as:
 *     [ launcher stub binary ]
 *     [ file entries         ]
 *     [ PackFooter (152 B)   ]
 *
 *   File entry:
 *     uint32 path_len  (LE)
 *     byte[] path      (UTF-8, forward-slash separators)
 *     uint64 data_len  (LE)
 *     byte[] data
 *
 *   PackFooter:
 *     uint32 file_count
 *     uint32 flags         (bit 0 = HIDE_CONSOLE)
 *     uint64 archive_offset
 *     char[128] main_path  (null-padded UTF-8)
 *     char[8]   magic      ("NGPACK01")
 */

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { execSync, spawnSync } = require('child_process');
const iconConverter = require('../lib/icon-converter');

/* -------------------------------------------------------------------------
 * Constants
 * -------------------------------------------------------------------------*/
const MAGIC           = 'NGPACK01';
const MAIN_PATH_MAX   = 128;
const FOOTER_SIZE     = 4 + 4 + 8 + MAIN_PATH_MAX + 8; // 152
const FLAG_HIDE_CONSOLE = 0x01;

/* Paths inside the node-gui package itself */
const PKG_DIR         = path.join(__dirname, '..');
const LAUNCHER_WIN    = path.join(PKG_DIR, 'src', 'launcher', 'launcher_win.c');
const LAUNCHER_POSIX  = path.join(PKG_DIR, 'src', 'launcher', 'launcher_posix.c');
const MANIFEST_WIN    = path.join(PKG_DIR, 'src', 'launcher', 'launcher_win.manifest');

/* Default exclusions when collecting project files */
const DEFAULT_EXCLUDES = [
    '.git',
    '.svn',
    '.hg',
    'node_modules/.bin',
    '.DS_Store',
    'Thumbs.db',
    '*.log',
    'npm-debug.log*',
];

// When node-gui is used as a dependency in another project, keep only the
// minimal runtime artifacts from node_modules/node-gui.
const NODE_GUI_RUNTIME_KEEP_RULES = [
    'node_modules/node-gui/*',
    '!node_modules/node-gui/index.js',
    '!node_modules/node-gui/package.json',
    '!node_modules/node-gui/build',
    'node_modules/node-gui/build/*',
    '!node_modules/node-gui/build/Release',
    '!node_modules/node-gui/build/Debug',
    'node_modules/node-gui/build/Release/*',
    'node_modules/node-gui/build/Debug/*',
    '!node_modules/node-gui/build/Release/node_gui.node',
    '!node_modules/node-gui/build/Debug/node_gui.node',
];

/* -------------------------------------------------------------------------
 * CLI arguments
 * -------------------------------------------------------------------------*/
function parseArgs(argv) {
    const options = {
        projectDir: process.cwd(),
        entryOverride: null,
        help: false,
    };

    let projectSetFromPositional = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-h' || arg === '--help') {
            options.help = true;
            continue;
        }
        if (arg === '-p' || arg === '--project') {
            if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
            options.projectDir = path.resolve(argv[++i]);
            projectSetFromPositional = true;
            continue;
        }
        if (arg === '-e' || arg === '--entry') {
            if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
            options.entryOverride = argv[++i];
            continue;
        }
        if (arg.startsWith('-')) {
            throw new Error(`Unknown option: ${arg}`);
        }
        if (projectSetFromPositional) {
            throw new Error('Project path specified more than once.');
        }
        options.projectDir = path.resolve(arg);
        projectSetFromPositional = true;
    }
    return options;
}

function printHelp() {
    const msg = [
        'node-gui-pack - bundle a node-gui app into one executable',
        '',
        'Usage:',
        '  node-gui-pack [projectDir] [--entry <path>]',
        '  node-gui-pack --project <path> --entry <path>',
        '',
        'Options:',
        '  -p, --project <path>   Project directory (default: current dir)',
        '  -e, --entry <path>     Entry script path relative to project root',
        '  -h, --help             Show this help message',
    ].join('\n');
    process.stdout.write(msg + '\n');
}

/* -------------------------------------------------------------------------
 * Load project settings
 * -------------------------------------------------------------------------*/
function firstString(...candidates) {
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim()) {
            return c;
        }
    }
    return null;
}

function normalizeProjectRelPath(filePath, projectDir, label) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
        die(`${label} must be a non-empty string.`);
    }

    let candidate = filePath.trim();
    if (path.isAbsolute(candidate)) {
        candidate = path.relative(projectDir, candidate);
    }

    // Keep archive paths platform-independent.
    candidate = candidate.replace(/\\/g, '/');
    while (candidate.startsWith('./')) {
        candidate = candidate.slice(2);
    }
    candidate = path.posix.normalize(candidate);

    if (!candidate || candidate === '.' || candidate === '..' || candidate.startsWith('../')) {
        die(`${label} must resolve inside the project directory: ${filePath}`);
    }

    return candidate;
}

function loadSettings(projectDir, entryOverride) {
    const pkgPath = path.join(projectDir, 'package.json');
    if (!fs.existsSync(pkgPath)) {
        die(`No package.json found in: ${projectDir}`);
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const packCfg = (pkg['node-gui'] && pkg['node-gui'].pack) || {};

    const appName    = pkg.name || 'app';
    const mainEntry  = firstString(
        entryOverride,
        packCfg.main,
        pkg.main,
        'index.js'
    );
    const hideConsole = packCfg.hideConsole !== false; // default true
    const iconFile   = packCfg.icon || null;
    const userExcludes = Array.isArray(packCfg.exclude) ? packCfg.exclude : [];

    let outputBase = packCfg.output || appName;
    // On Windows add .exe if not already present
    if (process.platform === 'win32' && !outputBase.endsWith('.exe')) {
        outputBase += '.exe';
    }

    return { pkg, appName, mainEntry, hideConsole, iconFile, userExcludes, outputBase };
}

/* -------------------------------------------------------------------------
 * File collection
 * -------------------------------------------------------------------------*/

/**
 * Returns true when a relative path (forward-slash separators) should be
 * excluded based on the list of patterns.  Patterns are matched against:
 *   - the full relative path
 *   - the basename
 * Simple '*' wildcard (within a single path component) is supported.
 * A pattern prefixed with '!' acts as a keep-rule (negation).
 */
function shouldExclude(relPath, patterns) {
    const base = relPath.split('/').pop();
    let excluded = false;
    for (const pattern of patterns) {
        if (pattern.startsWith('!')) {
            const keep = pattern.slice(1);
            if (matchPattern(relPath, keep) || matchPattern(base, keep)) {
                excluded = false;
            }
        } else {
            if (matchPattern(relPath, pattern) || matchPattern(base, pattern)) {
                excluded = true;
            }
        }
    }
    return excluded;
}

function matchPattern(str, pattern) {
    if (!pattern.includes('*')) {
        // Exact segment prefix match  (e.g. ".git" matches ".git/foo")
        return str === pattern || str.startsWith(pattern + '/');
    }
    // Convert glob pattern to regexp (single-level wildcard only)
    const re = new RegExp(
        '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                     .replace(/\*/g, '[^/]*') + '$'
    );
    return re.test(str);
}

/**
 * Recursively collect files under `dir`, returning
 *   [ { fullPath, relPath }, … ]
 * where relPath uses forward slashes and is relative to baseDir.
 */
function collectFiles(dir, excludePatterns, baseDir) {
    if (baseDir === undefined) baseDir = dir;
    const results = [];
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
        return results;
    }
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath  = path.relative(baseDir, fullPath).replace(/\\/g, '/');

        if (shouldExclude(relPath, excludePatterns)) continue;

        if (entry.isDirectory()) {
            results.push(...collectFiles(fullPath, excludePatterns, baseDir));
        } else if (entry.isFile() || entry.isSymbolicLink()) {
            results.push({ fullPath, relPath });
        }
    }
    return results;
}

/* -------------------------------------------------------------------------
 * Binary archive builder
 * -------------------------------------------------------------------------*/

/**
 * Build a Buffer containing all file entries + the PackFooter.
 * The caller prepends the launcher stub to produce the final executable.
 *
 * @param {Array<{fullPath: string, relPath: string}>} files
 * @param {number} launcherSize  – byte length of the launcher stub
 * @param {string} mainPath      – relative path to the main entry script
 * @param {number} flags         – pack flags (e.g. FLAG_HIDE_CONSOLE)
 * @returns {Buffer}
 */
function buildArchive(files, launcherSize, mainPath, flags) {
    const chunks = [];

    for (const { fullPath, relPath } of files) {
        const pathBuf = Buffer.from(relPath, 'utf8');
        let   dataBuf;
        try {
            dataBuf = fs.readFileSync(fullPath);
        } catch (e) {
            warn(`Skipping unreadable file: ${relPath} (${e.message})`);
            continue;
        }

        // path_len (uint32 LE)
        const pathLenBuf = Buffer.alloc(4);
        pathLenBuf.writeUInt32LE(pathBuf.length, 0);

        // data_len (uint64 LE via BigInt)
        const dataLenBuf = Buffer.alloc(8);
        dataLenBuf.writeBigUInt64LE(BigInt(dataBuf.length), 0);

        chunks.push(pathLenBuf, pathBuf, dataLenBuf, dataBuf);
    }

    const archiveBuf = Buffer.concat(chunks);
    const archiveOffset = launcherSize; // archive starts right after the stub

    // Build footer
    const footer = Buffer.alloc(FOOTER_SIZE, 0);
    let off = 0;
    footer.writeUInt32LE(files.length, off);       off += 4;
    footer.writeUInt32LE(flags, off);               off += 4;
    footer.writeBigUInt64LE(BigInt(archiveOffset), off); off += 8;

    // main_path (null-padded, MAIN_PATH_MAX bytes)
    const mainPathBuf = Buffer.from(mainPath, 'utf8');
    if (mainPathBuf.length >= MAIN_PATH_MAX) {
        die(`main path is too long (max ${MAIN_PATH_MAX - 1} bytes): ${mainPath}`);
    }
    mainPathBuf.copy(footer, off);
    off += MAIN_PATH_MAX;

    Buffer.from(MAGIC, 'ascii').copy(footer, off);

    return Buffer.concat([archiveBuf, footer]);
}

/* -------------------------------------------------------------------------
 * Compiler detection and launcher stub compilation
 * -------------------------------------------------------------------------*/

/** Run a command and return { ok, stdout, stderr }. */
function tryRun(cmd, args, opts) {
    const result = spawnSync(cmd, args, Object.assign({ encoding: 'utf8', timeout: 120000 }, opts));
    return {
        ok: result.status === 0 && !result.error,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
    };
}

/** Find an executable in PATH, returns its full path or null. */
function findExe(name) {
    const r = tryRun('which', [name]);
    if (r.ok) return r.stdout.trim();
    // On Windows 'where' is used instead of 'which'
    const r2 = tryRun('where', [name]);
    if (r2.ok) return r2.stdout.split(/\r?\n/)[0].trim();
    return null;
}

/**
 * Try to locate the vcvarsall.bat script via vswhere so we can compile
 * with MSVC even when cl.exe is not already on PATH.
 * Returns the full path to vcvarsall.bat, or null.
 */
function findVcvarsall() {
    const vswhere = path.join(
        process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
        'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    if (!fs.existsSync(vswhere)) return null;
    const r = tryRun(vswhere, [
        '-latest', '-products', '*',
        '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property', 'installationPath',
    ]);
    if (!r.ok || !r.stdout.trim()) return null;
    const vcvars = path.join(r.stdout.trim(), 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat');
    return fs.existsSync(vcvars) ? vcvars : null;
}

/**
 * Run a command inside a vcvarsall environment via a temporary batch file.
 * @param {string} vcvars - path to vcvarsall.bat
 * @param {string} cmd    - the command line to execute after vcvarsall
 * @param {object} [opts] - extra spawnSync options
 */
function tryRunVcvars(vcvars, cmd, opts) {
    const arch = process.arch === 'ia32' ? 'x86' : 'amd64';
    const batFile = path.join(os.tmpdir(), `ngpack_cl_${process.pid}.bat`);
    fs.writeFileSync(batFile, `@call "${vcvars}" ${arch} >nul 2>&1\r\n@${cmd}\r\n`);
    try {
        return tryRun('cmd', ['/c', batFile], opts);
    } finally {
        try { fs.unlinkSync(batFile); } catch (_) {}
    }
}

/**
 * Compile the Windows launcher using MSVC or MinGW.
 * Returns the path to the produced .exe, or throws on failure.
 */
function compileLauncherWin(outputExe, iconIco, appName, appVersion) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ngpack-'));

    // Parse version "1.2.3" into comma-separated 1,2,3,0
    const vParts = (appVersion || '1.0.0').split('.').map(Number);
    while (vParts.length < 4) vParts.push(0);
    const vComma = vParts.slice(0, 4).join(',');
    const vDot   = vParts.slice(0, 4).join('.');
    const name   = appName || 'node-gui-app';

    try {
        /* --- try MSVC (cl.exe) ----------------------------------------- */
        const clOnPath = !!findExe('cl');
        const vcvars   = !clOnPath ? findVcvarsall() : null;

        if (clOnPath || vcvars) {
            log('Compiling Windows launcher with MSVC…');

            /** helper: run either directly or via vcvarsall */
            const msvcRun = (cmd, args, runOpts) => {
                if (clOnPath) return tryRun(cmd, args, runOpts);
                const line = [cmd, ...args].map(a => /\s/.test(a) ? `"${a}"` : a).join(' ');
                return tryRunVcvars(vcvars, line, runOpts);
            };

            /* Build a combined .rc with version info + manifest + icon */
            const rcFile  = path.join(tmpDir, 'resource.rc');
            const resFile = path.join(tmpDir, 'resource.res');
            const manifestPath = MANIFEST_WIN.replace(/\\/g, '\\\\');
            let rc = '';
            rc += '#include <winver.h>\r\n\r\n';
            rc += `1 VERSIONINFO\r\n`;
            rc += `  FILEVERSION ${vComma}\r\n`;
            rc += `  PRODUCTVERSION ${vComma}\r\n`;
            rc += `  FILEFLAGSMASK 0x3fL\r\n`;
            rc += `  FILEFLAGS 0x0L\r\n`;
            rc += `  FILEOS 0x40004L\r\n`;
            rc += `  FILETYPE 0x1L\r\n`;
            rc += `BEGIN\r\n`;
            rc += `  BLOCK "StringFileInfo"\r\n`;
            rc += `  BEGIN\r\n`;
            rc += `    BLOCK "040904b0"\r\n`;
            rc += `    BEGIN\r\n`;
            rc += `      VALUE "CompanyName", "\\0"\r\n`;
            rc += `      VALUE "FileDescription", "${name}\\0"\r\n`;
            rc += `      VALUE "FileVersion", "${vDot}\\0"\r\n`;
            rc += `      VALUE "InternalName", "${name}\\0"\r\n`;
            rc += `      VALUE "OriginalFilename", "${path.basename(outputExe)}\\0"\r\n`;
            rc += `      VALUE "ProductName", "${name}\\0"\r\n`;
            rc += `      VALUE "ProductVersion", "${vDot}\\0"\r\n`;
            rc += `    END\r\n`;
            rc += `  END\r\n`;
            rc += `  BLOCK "VarFileInfo"\r\n`;
            rc += `  BEGIN\r\n`;
            rc += `    VALUE "Translation", 0x409, 1200\r\n`;
            rc += `  END\r\n`;
            rc += `END\r\n\r\n`;
            rc += `1 24 "${manifestPath}"\r\n`;
            if (iconIco && fs.existsSync(iconIco)) {
                rc += `IDI_ICON1 ICON "${iconIco.replace(/\\/g, '\\\\')}"\r\n`;
            }
            fs.writeFileSync(rcFile, rc);

            const rcResult = msvcRun('rc', ['/nologo', `/fo${resFile}`, rcFile], { cwd: tmpDir });
            const rcObj = rcResult.ok ? resFile : '';
            if (!rcResult.ok) {
                warn('rc.exe failed – version info / manifest will not be embedded.');
            }

            const args = [
                '/nologo', '/O2', '/TC', '/W3',
                LAUNCHER_WIN,
                `/Fe${outputExe}`,
                '/link', '/SUBSYSTEM:WINDOWS',
                'user32.lib',
            ];
            if (rcObj) args.push(rcObj);

            const result = msvcRun('cl', args, { cwd: tmpDir });
            if (!result.ok) {
                throw new Error(`MSVC compilation failed:\n${result.stdout}${result.stderr}`);
            }
            return outputExe;
        }

        /* --- try MinGW-w64 --------------------------------------------- */
        const gcc = findExe('x86_64-w64-mingw32-gcc') || findExe('gcc') || findExe('cc');
        if (gcc) {
            log(`Compiling Windows launcher with ${path.basename(gcc)}…`);

            let resObj = '';
            const windres = findExe('windres') ||
                            findExe('x86_64-w64-mingw32-windres');
            if (windres) {
                const rcFile  = path.join(tmpDir, 'resource.rc');
                const resFile = path.join(tmpDir, 'resource.o');
                const manifestPath = MANIFEST_WIN.replace(/\\/g, '\\\\');
                let rc = '';
                rc += '#include <winver.h>\n\n';
                rc += `1 VERSIONINFO\n`;
                rc += `  FILEVERSION ${vComma}\n`;
                rc += `  PRODUCTVERSION ${vComma}\n`;
                rc += `  FILEFLAGSMASK 0x3fL\n`;
                rc += `  FILEFLAGS 0x0L\n`;
                rc += `  FILEOS 0x40004L\n`;
                rc += `  FILETYPE 0x1L\n`;
                rc += `BEGIN\n`;
                rc += `  BLOCK "StringFileInfo"\n`;
                rc += `  BEGIN\n`;
                rc += `    BLOCK "040904b0"\n`;
                rc += `    BEGIN\n`;
                rc += `      VALUE "CompanyName", "\\0"\n`;
                rc += `      VALUE "FileDescription", "${name}\\0"\n`;
                rc += `      VALUE "FileVersion", "${vDot}\\0"\n`;
                rc += `      VALUE "InternalName", "${name}\\0"\n`;
                rc += `      VALUE "OriginalFilename", "${path.basename(outputExe)}\\0"\n`;
                rc += `      VALUE "ProductName", "${name}\\0"\n`;
                rc += `      VALUE "ProductVersion", "${vDot}\\0"\n`;
                rc += `    END\n`;
                rc += `  END\n`;
                rc += `  BLOCK "VarFileInfo"\n`;
                rc += `  BEGIN\n`;
                rc += `    VALUE "Translation", 0x409, 1200\n`;
                rc += `  END\n`;
                rc += `END\n\n`;
                rc += `1 24 "${manifestPath}"\n`;
                if (iconIco && fs.existsSync(iconIco)) {
                    rc += `IDI_ICON1 ICON "${iconIco.replace(/\\/g, '\\\\')}"\n`;
                }
                fs.writeFileSync(rcFile, rc);
                const wrResult = tryRun(windres,
                    ['-i', rcFile, '-O', 'coff', '-o', resFile],
                    { cwd: tmpDir });
                if (wrResult.ok) {
                    resObj = resFile;
                } else {
                    warn('windres failed – version info / manifest will not be embedded.');
                }
            }

            const args = ['-O2', '-o', outputExe, LAUNCHER_WIN];
            if (resObj) args.push(resObj);
            args.push('-mwindows', '-luser32');

            const result = tryRun(gcc, args, { cwd: tmpDir });
            if (!result.ok) {
                throw new Error(`GCC compilation failed:\n${result.stderr}`);
            }
            return outputExe;
        }

        throw new Error(
            'No C compiler found.\n' +
            'Install Visual Studio (with C++ workload) or MinGW-w64, then re-run.'
        );
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
}

/**
 * Compile the POSIX launcher using cc/gcc/clang.
 * Returns the path to the produced binary, or throws on failure.
 */
function compileLauncherPosix(outputBin) {
    const cc = findExe('cc') || findExe('gcc') || findExe('clang');
    if (!cc) {
        throw new Error(
            'No C compiler found (tried cc, gcc, clang).\n' +
            'Install build-essential (Debian/Ubuntu) or Xcode Command Line Tools (macOS).'
        );
    }

    log(`Compiling launcher with ${path.basename(cc)}…`);
    const args = ['-O2', '-o', outputBin, LAUNCHER_POSIX];
    const result = tryRun(cc, args);
    if (!result.ok) {
        throw new Error(`Compilation failed:\n${result.stderr}`);
    }
    // Make executable
    fs.chmodSync(outputBin, 0o755);
    return outputBin;
}

/**
 * Compile the launcher stub for the current platform.
 * Returns the path to the compiled binary (in a temp file).
 */
function compileLauncher(iconIco, appName, appVersion) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ngpack-stub-'));
    const stubPath = path.join(tmpDir,
        process.platform === 'win32' ? 'launcher.exe' : 'launcher');

    try {
        if (process.platform === 'win32') {
            compileLauncherWin(stubPath, iconIco, appName, appVersion);
        } else {
            compileLauncherPosix(stubPath);
        }
    } catch (e) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
        throw e;
    }

    return { stubPath, tmpDir };
}

/* -------------------------------------------------------------------------
 * Windows icon update via UpdateResource API
 * (used when the launcher was already compiled without an icon and we want
 *  to set one post-hoc – currently unused but left for future use)
 * -------------------------------------------------------------------------*/

/* -------------------------------------------------------------------------
 * Logging helpers
 * -------------------------------------------------------------------------*/
function log(msg)  { process.stdout.write(`[node-gui-pack] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[node-gui-pack] WARNING: ${msg}\n`); }
function die(msg)  { process.stderr.write(`[node-gui-pack] ERROR: ${msg}\n`); process.exit(1); }

/* -------------------------------------------------------------------------
 * Main
 * -------------------------------------------------------------------------*/
function main() {
    let cli;
    try {
        cli = parseArgs(process.argv.slice(2));
    } catch (e) {
        die(e.message);
    }

    if (cli.help) {
        printHelp();
        return;
    }

    const projectDir = cli.projectDir;
    if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
        die(`Project directory does not exist: ${projectDir}`);
    }

    const settings = loadSettings(projectDir, cli.entryOverride);
    const {
        pkg, appName, mainEntry, hideConsole, iconFile, userExcludes, outputBase,
    } = settings;

    const mainNorm = normalizeProjectRelPath(mainEntry, projectDir, 'Main entry');
    const outputPath = path.resolve(projectDir, outputBase);

    // Ensure output directory exists
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Resolve icon path relative to project
    const iconPath = iconFile ? path.resolve(projectDir, iconFile) : null;
    if (iconPath && !fs.existsSync(iconPath)) {
        warn(`Icon file not found: ${iconPath} – proceeding without icon.`);
    }

    // Convert icon to platform-specific format if needed
    let convertedIconPath = null;
    let convertedIconTmpDir = null;
    if (iconPath && fs.existsSync(iconPath)) {
        const inputFormat = iconConverter.detectFormat(iconPath);
        
        if (inputFormat === 'unknown') {
            warn(`Unknown icon format: ${path.extname(iconPath)} – proceeding without icon.`);
        } else {
            // Determine the required format for the current platform
            const requiredFormat = process.platform === 'win32' ? 'ico' : 
                                   process.platform === 'darwin' ? 'icns' : 'png';
            
            if (inputFormat !== requiredFormat) {
                // Icon conversion needed
                convertedIconTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ngpack-icon-'));
                const convertedExt = requiredFormat;
                convertedIconPath = path.join(convertedIconTmpDir, `converted_icon.${convertedExt}`);
                
                try {
                    iconConverter.convertIconForPlatform(iconPath, convertedIconPath, process.platform);
                    log(`Icon:            ${convertedIconPath} (converted from ${inputFormat.toUpperCase()})`);
                } catch (e) {
                    warn(`Icon conversion failed: ${e.message} – proceeding without icon.`);
                    convertedIconPath = null;
                    try { fs.rmSync(convertedIconTmpDir, { recursive: true, force: true }); } catch (_) {}
                    convertedIconTmpDir = null;
                }
            } else {
                // Icon is already in the correct format
                convertedIconPath = iconPath;
                log(`Icon:            ${convertedIconPath}`);
            }
        }
    }

    log(`Packing project: ${projectDir}`);
    log(`Main entry:      ${mainNorm}`);
    log(`Output:          ${outputPath}`);
    if (process.platform === 'win32') log(`Hide console:    ${hideConsole}`);

    /* 1. Collect project files -------------------------------------------- */
    const excludePatterns = [
        ...DEFAULT_EXCLUDES,
        ...NODE_GUI_RUNTIME_KEEP_RULES,
        ...userExcludes,
    ];

    // Also exclude the output file itself (if it's inside the project dir)
    const relOutput = path.relative(projectDir, outputPath).replace(/\\/g, '/');
    if (!relOutput.startsWith('..')) excludePatterns.push(relOutput);

    log('Collecting project files…');
    const files = collectFiles(projectDir, excludePatterns);
    log(`  ${files.length} files collected.`);

    if (files.length === 0) {
        die('No project files found to pack.');
    }

    /* 2. Verify main entry exists in the collected files ------------------- */
    if (!files.some(f => f.relPath === mainNorm)) {
        const mainAbs = path.join(projectDir, mainNorm);
        if (fs.existsSync(mainAbs)) {
            die(
                `Main entry "${mainNorm}" exists on disk but was excluded from the pack. ` +
                'Update your "node-gui.pack.exclude" patterns.'
            );
        }
        die(
            `Main entry "${mainNorm}" was not found. ` +
            'Set "node-gui.pack.main" in package.json to a valid file.'
        );
    }

    /* 3. Compile the launcher stub ---------------------------------------- */
    let stubPath, tmpDir;
    try {
        ({ stubPath, tmpDir } = compileLauncher(
            convertedIconPath,
            appName,
            pkg.version
        ));
    } catch (e) {
        die(e.message);
    }

    /* 4. Read the launcher stub ------------------------------------------- */
    const launcherBuf = fs.readFileSync(stubPath);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

    /* 5. Build the archive buffer ----------------------------------------- */
    // On non-Windows platforms set the flag based on user preference regardless;
    // the POSIX launcher ignores it.
    const packFlags = hideConsole ? FLAG_HIDE_CONSOLE : 0;

    const archiveBuf = buildArchive(files, launcherBuf.length, mainNorm, packFlags);

    /* 6. Write output file ------------------------------------------------ */
    log('Writing output…');
    const outFd = fs.openSync(outputPath, 'w');
    fs.writeSync(outFd, launcherBuf);
    fs.writeSync(outFd, archiveBuf);
    fs.closeSync(outFd);

    // Make executable on POSIX
    if (process.platform !== 'win32') {
        fs.chmodSync(outputPath, 0o755);
    }

    // Clean up converted icon directory if it was created
    if (convertedIconTmpDir) {
        try { fs.rmSync(convertedIconTmpDir, { recursive: true, force: true }); } catch (_) {}
    }

    const outSize = fs.statSync(outputPath).size;
    log(`Done!  ${outputPath}  (${(outSize / 1024 / 1024).toFixed(1)} MB)`);
}

main();
