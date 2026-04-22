'use strict';

/**
 * icon-converter.js
 * 
 * Converts image files (SVG, PNG, JPG) to platform-specific icon formats:
 * - Windows: .ico (256x256)
 * - macOS: .icns (512x512)
 * - Linux: .png (256x256)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ISOLATED_TOOLS_NODE_MODULES = path.join(__dirname, '..', '.node-gui-tools', 'node_modules');

function loadOptionalModule(name) {
    const isolatedPath = path.join(ISOLATED_TOOLS_NODE_MODULES, name);
    try {
        if (fs.existsSync(isolatedPath)) {
            return require(isolatedPath);
        }
    } catch (_) {}

    try {
        return require(name);
    } catch (_) {
        return null;
    }
}

/**
 * Detect the input file format
 * @param {string} filePath
 * @returns {string} 'svg' | 'png' | 'jpg' | 'ico' | 'icns' | 'unknown'
 */
function detectFormat(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mapping = {
        '.svg': 'svg',
        '.png': 'png',
        '.jpg': 'jpg',
        '.jpeg': 'jpg',
        '.ico': 'ico',
        '.icns': 'icns',
    };
    return mapping[ext] || 'unknown';
}

/**
 * Check if ImageMagick's convert command is available
 * @returns {boolean}
 */
function hasImageMagick() {
    const magick = spawnSync('magick', ['-version'], { encoding: 'utf8', timeout: 2000 });
    if (magick.status === 0 && /ImageMagick/i.test((magick.stdout || '') + (magick.stderr || ''))) {
        return true;
    }

    const convert = spawnSync('convert', ['-version'], { encoding: 'utf8', timeout: 2000 });
    if (convert.status === 0 && /ImageMagick/i.test((convert.stdout || '') + (convert.stderr || ''))) {
        return true;
    }

    return false;
}

/**
 * Check if sharp is available
 * @returns {boolean}
 */
function hasSharp() {
    return !!loadOptionalModule('sharp');
}

function hasJimp() {
    return !!loadOptionalModule('jimp');
}

function runImageMagick(args) {
    const magick = spawnSync('magick', args, { encoding: 'utf8', timeout: 30000 });
    if (magick.status === 0) {
        return true;
    }

    const convert = spawnSync('convert', args, { encoding: 'utf8', timeout: 30000 });
    return convert.status === 0;
}

async function getJimpClass() {
    const mod = loadOptionalModule('jimp');
    if (!mod) {
        throw new Error('jimp is not available.');
    }
    return mod.Jimp || mod.default || mod;
}

async function writeJimpImage(image, outputPath) {
    if (typeof image.writeAsync === 'function') {
        await image.writeAsync(outputPath);
        return;
    }
    await new Promise((resolve, reject) => {
        image.write(outputPath, (err) => (err ? reject(err) : resolve()));
    });
}

/**
 * Convert image to PNG using sharp or ImageMagick
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {number} size - output size in pixels
 */
async function convertToPng(inputPath, outputPath, size) {
    if (hasSharp()) {
        const sharp = loadOptionalModule('sharp');
        try {
            await sharp(inputPath)
                .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .png()
                .toFile(outputPath);
            return true;
        } catch (e) {
            console.warn(`[icon-converter] sharp failed: ${e.message}`);
        }
    }

    if (hasImageMagick()) {
        try {
            const ok = runImageMagick([
                inputPath,
                '-resize', `${size}x${size}`,
                '-background', 'none',
                '-gravity', 'center',
                '-extent', `${size}x${size}`,
                outputPath,
            ]);
            if (ok) {
                return true;
            }
        } catch (e) {
            console.warn(`[icon-converter] ImageMagick convert failed: ${e.message}`);
        }
    }

    if (hasJimp()) {
        try {
            const Jimp = await getJimpClass();
            const image = await Jimp.read(inputPath);
            image.resize(size, size);
            await writeJimpImage(image, outputPath);
            return true;
        } catch (e) {
            console.warn(`[icon-converter] jimp failed: ${e.message}`);
        }
    }

    return false;
}

function createIcoFromPngBuffer(pngBuffer, icoPath) {
    const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    if (pngBuffer.length < 24 || !pngBuffer.slice(0, 8).equals(pngSignature)) {
        throw new Error('PNG data is invalid.');
    }

    const width = pngBuffer.readUInt32BE(16);
    const height = pngBuffer.readUInt32BE(20);

    const iconDir = Buffer.alloc(6);
    iconDir.writeUInt16LE(0, 0); // reserved
    iconDir.writeUInt16LE(1, 2); // type=icon
    iconDir.writeUInt16LE(1, 4); // count=1

    const entry = Buffer.alloc(16);
    entry.writeUInt8(width >= 256 ? 0 : width, 0);
    entry.writeUInt8(height >= 256 ? 0 : height, 1);
    entry.writeUInt8(0, 2); // palette colors
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(pngBuffer.length, 8);
    entry.writeUInt32LE(6 + 16, 12);

    fs.writeFileSync(icoPath, Buffer.concat([iconDir, entry, pngBuffer]));
}

/**
 * Convert SVG to ICO via PNG intermediate
 * @param {string} svgPath
 * @param {string} icoPath
 */
async function svgToIco(svgPath, icoPath) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ngpack-icon-'));
    const tmpPng = path.join(tmpDir, 'temp.png');

    try {
        // SVG -> PNG (256x256)
        if (!await convertToPng(svgPath, tmpPng, 256)) {
            throw new Error('Failed to convert SVG to PNG');
        }

        const pngBuffer = fs.readFileSync(tmpPng);
        createIcoFromPngBuffer(pngBuffer, icoPath);
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
}

/**
 * Convert PNG/JPG to ICO
 * @param {string} inputPath
 * @param {string} icoPath
 */
async function pngToIco(inputPath, icoPath) {
    const format = detectFormat(inputPath);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ngpack-icon-'));
    const tmpPng = path.join(tmpDir, 'icon.png');

    try {
        if (format === 'png') {
            // PNG can be embedded directly in ICO, no external tools required.
            let pngSource = inputPath;
            if (hasSharp() || hasImageMagick() || hasJimp()) {
                const resized = await convertToPng(inputPath, tmpPng, 256);
                if (resized) {
                    pngSource = tmpPng;
                }
            }
            const pngBuffer = fs.readFileSync(pngSource);
            createIcoFromPngBuffer(pngBuffer, icoPath);
            return;
        }

        if (format === 'jpg') {
            if (!await convertToPng(inputPath, tmpPng, 256)) {
                throw new Error('Could not convert JPG to PNG before ICO generation.');
            }
            const pngBuffer = fs.readFileSync(tmpPng);
            createIcoFromPngBuffer(pngBuffer, icoPath);
            return;
        }

        throw new Error(`Unsupported input format for ICO conversion: ${format}`);
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
}

/**
 * Convert to ICNS (macOS)
 * PNG/JPG -> ICNS
 * SVG -> PNG -> ICNS
 * @param {string} inputPath
 * @param {string} icnsPath
 */
async function toIcns(inputPath, icnsPath) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ngpack-icon-'));
    const tmpPng = path.join(tmpDir, 'temp.png');
    const tmpIcns = path.join(tmpDir, 'temp.iconset');

    try {
        const inputFormat = detectFormat(inputPath);

        // Step 1: Convert to PNG if needed
        if (inputFormat === 'svg') {
            if (!await convertToPng(inputPath, tmpPng, 512)) {
                throw new Error('Failed to convert SVG to PNG');
            }
        } else if (inputFormat === 'png') {
            fs.copyFileSync(inputPath, tmpPng);
        } else if (inputFormat === 'jpg') {
            if (!await convertToPng(inputPath, tmpPng, 512)) {
                throw new Error('Failed to convert JPG to PNG');
            }
        } else {
            throw new Error(`Unsupported input format for ICNS: ${inputFormat}`);
        }

        // Step 2: Use iconutil (macOS only) to create ICNS
        if (process.platform === 'darwin') {
            // Create iconset directory with required sizes
            fs.mkdirSync(tmpIcns, { recursive: true });

            const sizes = [16, 32, 64, 128, 256, 512];
            for (const size of sizes) {
                const output = path.join(tmpIcns, `icon_${size}x${size}.png`);
                const output2x = path.join(tmpIcns, `icon_${size}x${size}@2x.png`);
                
                if (hasImageMagick()) {
                    // Use ImageMagick to resize
                    try {
                        runImageMagick([tmpPng, '-resize', `${size}x${size}`, output]);
                        runImageMagick([tmpPng, '-resize', `${size * 2}x${size * 2}`, output2x]);
                    } catch (e) {
                        console.warn(`[icon-converter] Failed to create size variant: ${e.message}`);
                    }
                } else if (hasSharp()) {
                    // Use sharp to resize
                    const sharp = loadOptionalModule('sharp');
                    try {
                        await sharp(tmpPng).resize(size, size).png().toFile(output);
                        await sharp(tmpPng).resize(size * 2, size * 2).png().toFile(output2x);
                    } catch (e) {
                        console.warn(`[icon-converter] Failed to create size variant: ${e.message}`);
                    }
                }
            }

            // Use iconutil to create the ICNS file
            const result = spawnSync('iconutil', ['-c', 'icns', '-o', icnsPath, tmpIcns], 
                                    { encoding: 'utf8', timeout: 30000 });
            if (result.status !== 0) {
                throw new Error(`iconutil failed: ${result.stderr}`);
            }
        } else {
            throw new Error('ICNS conversion is only supported on macOS');
        }
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
}

/**
 * Convert to PNG (Linux)
 * @param {string} inputPath
 * @param {string} pngPath
 */
async function toPng(inputPath, pngPath) {
    const inputFormat = detectFormat(inputPath);

    if (inputFormat === 'png') {
        // Already PNG, just copy
        fs.copyFileSync(inputPath, pngPath);
    } else if (inputFormat === 'svg' || inputFormat === 'jpg') {
        // Convert to PNG
        if (!await convertToPng(inputPath, pngPath, 256)) {
            throw new Error(`Failed to convert ${inputFormat.toUpperCase()} to PNG`);
        }
    } else {
        throw new Error(`Unsupported input format for PNG: ${inputFormat}`);
    }
}

/**
 * Convert an icon file to the format required for the target platform
 * @param {string} inputPath - path to the input icon file (SVG, PNG, JPG, etc.)
 * @param {string} outputPath - path to save the converted icon
 * @param {string} [platform] - target platform ('win32', 'darwin', 'linux'). Defaults to current platform.
 */
async function convertIconForPlatform(inputPath, outputPath, platform) {
    if (!fs.existsSync(inputPath)) {
        throw new Error(`Icon file not found: ${inputPath}`);
    }

    platform = platform || process.platform;
    const inputFormat = detectFormat(inputPath);

    if (inputFormat === 'unknown') {
        throw new Error(`Unknown icon file format: ${path.extname(inputPath)}`);
    }

    console.log(`[icon-converter] Converting ${inputFormat.toUpperCase()} to ${platform} format…`);

    switch (platform) {
        case 'win32':
            // Convert to ICO
            if (inputFormat === 'ico') {
                fs.copyFileSync(inputPath, outputPath);
            } else if (inputFormat === 'svg') {
                await svgToIco(inputPath, outputPath);
            } else if (inputFormat === 'png' || inputFormat === 'jpg') {
                await pngToIco(inputPath, outputPath);
            } else if (inputFormat === 'icns') {
                throw new Error('Cannot convert macOS ICNS to Windows ICO');
            }
            break;

        case 'darwin':
            // Convert to ICNS
            if (inputFormat === 'icns') {
                fs.copyFileSync(inputPath, outputPath);
            } else {
                await toIcns(inputPath, outputPath);
            }
            break;

        case 'linux':
            // Convert to PNG
            if (inputFormat === 'ico' || inputFormat === 'icns') {
                throw new Error(`Cannot convert ${inputFormat.toUpperCase()} to PNG for Linux`);
            }
            await toPng(inputPath, outputPath);
            break;

        default:
            throw new Error(`Unknown platform: ${platform}`);
    }

    console.log(`[icon-converter] Saved ${platform} icon to: ${outputPath}`);
}

module.exports = {
    detectFormat,
    convertIconForPlatform,
    hasSharp,
    hasImageMagick,
    hasJimp,
};
