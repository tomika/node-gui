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
const { execSync, spawnSync } = require('child_process');

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
    try {
        spawnSync(process.platform === 'win32' ? 'where' : 'which', 
                  ['convert'], 
                  { stdio: 'ignore', timeout: 1000 });
        return true;
    } catch {
        return false;
    }
}

/**
 * Check if sharp is available
 * @returns {boolean}
 */
function hasSharp() {
    try {
        require('sharp');
        return true;
    } catch {
        return false;
    }
}

/**
 * Convert image to PNG using sharp or ImageMagick
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {number} size - output size in pixels
 */
function convertToPng(inputPath, outputPath, size) {
    if (hasSharp()) {
        const sharp = require('sharp');
        try {
            sharp(inputPath)
                .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .toFile(outputPath);
            return true;
        } catch (e) {
            console.warn(`[icon-converter] sharp failed: ${e.message}`);
            return false;
        }
    }

    if (hasImageMagick()) {
        try {
            const result = spawnSync('convert', [
                inputPath,
                '-resize', `${size}x${size}`,
                '-background', 'none',
                '-gravity', 'center',
                '-extent', `${size}x${size}`,
                outputPath,
            ], { encoding: 'utf8', timeout: 30000 });
            return result.status === 0;
        } catch (e) {
            console.warn(`[icon-converter] ImageMagick convert failed: ${e.message}`);
            return false;
        }
    }

    return false;
}

/**
 * Convert SVG to ICO via PNG intermediate
 * @param {string} svgPath
 * @param {string} icoPath
 */
function svgToIco(svgPath, icoPath) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ngpack-icon-'));
    const tmpPng = path.join(tmpDir, 'temp.png');

    try {
        // SVG -> PNG (256x256)
        if (!convertToPng(svgPath, tmpPng, 256)) {
            throw new Error('Failed to convert SVG to PNG');
        }

        // PNG -> ICO using ImageMagick or built-in conversion
        pngToIco(tmpPng, icoPath);
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
}

/**
 * Convert PNG/JPG to ICO
 * @param {string} inputPath
 * @param {string} icoPath
 */
function pngToIco(inputPath, icoPath) {
    // Try using ImageMagick
    if (hasImageMagick()) {
        try {
            const result = spawnSync('convert', [
                inputPath,
                '-resize', '256x256',
                '-background', 'white',
                '-gravity', 'center',
                '-extent', '256x256',
                icoPath,
            ], { encoding: 'utf8', timeout: 30000 });
            if (result.status === 0) return;
        } catch (e) {
            console.warn(`[icon-converter] ImageMagick ICO conversion failed: ${e.message}`);
        }
    }

    // Fallback: try using jimp (if available) or copy as-is and hope Windows can handle it
    try {
        const jimp = require('jimp');
        const image = jimp.read(inputPath);
        image.resize(256, 256).write(icoPath);
    } catch {
        // Last resort: just warn
        throw new Error(
            'Could not convert to ICO format. ' +
            'Please install ImageMagick (convert command) or jimp npm package.'
        );
    }
}

/**
 * Convert to ICNS (macOS)
 * PNG/JPG -> ICNS
 * SVG -> PNG -> ICNS
 * @param {string} inputPath
 * @param {string} icnsPath
 */
function toIcns(inputPath, icnsPath) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ngpack-icon-'));
    const tmpPng = path.join(tmpDir, 'temp.png');
    const tmpIcns = path.join(tmpDir, 'temp.iconset');

    try {
        const inputFormat = detectFormat(inputPath);

        // Step 1: Convert to PNG if needed
        if (inputFormat === 'svg') {
            if (!convertToPng(inputPath, tmpPng, 512)) {
                throw new Error('Failed to convert SVG to PNG');
            }
        } else if (inputFormat === 'png') {
            fs.copyFileSync(inputPath, tmpPng);
        } else if (inputFormat === 'jpg') {
            if (!convertToPng(inputPath, tmpPng, 512)) {
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
                        spawnSync('convert', [tmpPng, '-resize', `${size}x${size}`, output], 
                                 { stdio: 'ignore', timeout: 10000 });
                        spawnSync('convert', [tmpPng, '-resize', `${size * 2}x${size * 2}`, output2x], 
                                 { stdio: 'ignore', timeout: 10000 });
                    } catch (e) {
                        console.warn(`[icon-converter] Failed to create size variant: ${e.message}`);
                    }
                } else if (hasSharp()) {
                    // Use sharp to resize
                    const sharp = require('sharp');
                    try {
                        sharp(tmpPng).resize(size, size).toFile(output);
                        sharp(tmpPng).resize(size * 2, size * 2).toFile(output2x);
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
function toPng(inputPath, pngPath) {
    const inputFormat = detectFormat(inputPath);

    if (inputFormat === 'png') {
        // Already PNG, just copy
        fs.copyFileSync(inputPath, pngPath);
    } else if (inputFormat === 'svg' || inputFormat === 'jpg') {
        // Convert to PNG
        if (!convertToPng(inputPath, pngPath, 256)) {
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
function convertIconForPlatform(inputPath, outputPath, platform) {
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
                svgToIco(inputPath, outputPath);
            } else if (inputFormat === 'png' || inputFormat === 'jpg') {
                pngToIco(inputPath, outputPath);
            } else if (inputFormat === 'icns') {
                throw new Error('Cannot convert macOS ICNS to Windows ICO');
            }
            break;

        case 'darwin':
            // Convert to ICNS
            if (inputFormat === 'icns') {
                fs.copyFileSync(inputPath, outputPath);
            } else {
                toIcns(inputPath, outputPath);
            }
            break;

        case 'linux':
            // Convert to PNG
            if (inputFormat === 'ico' || inputFormat === 'icns') {
                throw new Error(`Cannot convert ${inputFormat.toUpperCase()} to PNG for Linux`);
            }
            toPng(inputPath, outputPath);
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
};
