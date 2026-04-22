'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PKG_DIR = path.join(__dirname, '..');
const TOOLS_DIR = path.join(PKG_DIR, '.node-gui-tools');
const TOOLS_PKG = path.join(TOOLS_DIR, 'package.json');

function log(msg) {
    process.stdout.write(`[node-gui-postinstall] ${msg}\n`);
}

function warn(msg) {
    process.stderr.write(`[node-gui-postinstall] WARNING: ${msg}\n`);
}

function runInstaller(args, cwd) {
    const attempts = [];

    if (process.env.npm_execpath) {
        attempts.push({
            command: process.execPath,
            commandArgs: [process.env.npm_execpath, ...args],
        });
    }

    attempts.push({ command: 'npm', commandArgs: args });
    if (process.platform === 'win32') {
        attempts.push({ command: 'npm.cmd', commandArgs: args });
        attempts.push({ command: 'cmd', commandArgs: ['/d', '/s', '/c', `npm ${args.join(' ')}`] });
    }

    for (const attempt of attempts) {
        const result = spawnSync(attempt.command, attempt.commandArgs, {
            cwd,
            stdio: 'pipe',
            encoding: 'utf8',
            timeout: 180000,
        });

        if (!result.error) {
            return result;
        }
    }

    return { error: new Error('No usable npm command found.'), status: 1, stderr: '' };
}

function ensureToolsPackageJson() {
    fs.mkdirSync(TOOLS_DIR, { recursive: true });

    if (!fs.existsSync(TOOLS_PKG)) {
        const pkgJson = {
            name: 'node-gui-icon-tools',
            private: true,
            version: '1.0.0',
            description: 'Isolated optional icon conversion tools for node-gui',
        };
        fs.writeFileSync(TOOLS_PKG, JSON.stringify(pkgJson, null, 2));
    }
}

function installToolDependencies() {
    const args = [
        'install',
        '--no-save',
        '--no-package-lock',
        '--ignore-scripts',
        'jimp@^0.22.0',
    ];

    const result = runInstaller(args, TOOLS_DIR);

    if (result.error) {
        warn(`Failed to install icon tools: ${result.error.message}`);
        return false;
    }

    if (result.status !== 0) {
        warn('Could not install isolated icon tools. PNG/JPG conversion fallback may be unavailable.');
        if (result.stderr) {
            warn(result.stderr.trim());
        }
        return false;
    }

    return true;
}

function main() {
    try {
        ensureToolsPackageJson();
        log(`Preparing isolated icon tools in ${TOOLS_DIR}`);

        const installed = installToolDependencies();
        if (installed) {
            log('Installed isolated icon conversion tool: jimp');
        }
    } catch (err) {
        warn(`Unexpected postinstall failure: ${err.message}`);
    }
}

main();
