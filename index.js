'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

let binding;
try {
  binding = require(path.join(__dirname, 'build', 'Release', 'node_gui.node'));
} catch {
  binding = require(path.join(__dirname, 'build', 'Debug', 'node_gui.node'));
}

const { GuiWindow } = binding;
const MESSAGE_BRIDGE_PATH = '/node-gui-message.js';
const MESSAGE_BRIDGE_CONTENT = fs.readFileSync(
  path.join(__dirname, 'lib', 'message-to-backend.js'),
  'utf8'
);

function parseJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw.length ? JSON.parse(raw) : null);
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

function isSafeFilePath(baseDir, reqPath) {
  const normalized = path.normalize(reqPath).replace(/^([\\/])+/, '');
  const absolute = path.resolve(baseDir, normalized);
  const relative = path.relative(baseDir, absolute);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function contentTypeFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.ico': return 'image/x-icon';
    default: return 'application/octet-stream';
  }
}

function createInternalServer(options) {
  const frontendDir = path.resolve(options.frontendDir || process.cwd());
  const maxBodyBytes = options.maxMessageBodyBytes || 1024 * 1024;

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;

        if (req.method === 'POST' && pathname === '/') {
          const requestValue = await parseJsonBody(req, maxBodyBytes);
          const responseValue = await Promise.resolve(options.onMessage(requestValue));

          if (responseValue === undefined) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'onMessage must return a JSON value' }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(responseValue));
          return;
        }

        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Method Not Allowed');
          return;
        }

        const requestPath = pathname === '/' ? '/index.html' : pathname;
        if (requestPath === MESSAGE_BRIDGE_PATH) {
          res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
          res.end(MESSAGE_BRIDGE_CONTENT);
          return;
        }

        if (!isSafeFilePath(frontendDir, requestPath)) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Forbidden');
          return;
        }

        const localPath = path.resolve(frontendDir, '.' + requestPath);
        fs.readFile(localPath, (err, data) => {
          if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not Found');
            return;
          }
          res.writeHead(200, { 'Content-Type': contentTypeFor(localPath) });
          res.end(data);
        });
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message || 'Internal Server Error' }));
      }
    });

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve({
        server,
        port: server.address().port,
      });
    });
  });
}

/**
 * Open a native window with an embedded browser control pointing to
 * http://localhost:<port>.
 *
 * @param {object}  options
 * @param {number}  options.width    - Initial window width in pixels.
 * @param {number}  options.height   - Initial window height in pixels.
 * @param {number}  [options.port]   - Port number on localhost to navigate to.
 *                                     Required when onMessage is not provided.
 * @param {function} [options.onMessage] - Optional backend RPC callback used by
 *                                         internal server mode:
 *                                         async (jsonValue) => jsonValue.
 * @param {string}  [options.frontendDir] - Directory to serve static frontend files
 *                                          from when onMessage is provided.
 * @param {number}  [options.maxMessageBodyBytes] - Max accepted POST body size in
 *                                                  bytes for internal server mode.
 * @param {function} [options.onClose] - Callback invoked when the window is
 *                                       closed (by the user or via close()).
 * @param {function} [options.onSizeChanged] - Callback invoked when the
 *                                              measured content size or window
 *                                              size changes: `(info) => void`.
 *                                              `info.source` is `'content'`,
 *                                              `'user-resize'` or `'programmatic-resize'`.
 * @param {object}   [options.contentSizeOptions] - Tuning for content-size measurement.
 * @returns {{ close: function, move: function, resize: function }}
 *          A handle with close/move/resize methods.
 */
function open(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('options must be an object');
  }
  if (typeof options.width !== 'number' || options.width <= 0) {
    throw new TypeError('options.width must be a positive number');
  }
  if (typeof options.height !== 'number' || options.height <= 0) {
    throw new TypeError('options.height must be a positive number');
  }
  const hasOnMessage = options.onMessage !== undefined;
  if (hasOnMessage && typeof options.onMessage !== 'function') {
    throw new TypeError('options.onMessage must be a function when provided');
  }
  if (!hasOnMessage) {
    if (typeof options.port !== 'number' || options.port <= 0 || options.port > 65535) {
      throw new TypeError('options.port must be a number between 1 and 65535 when options.onMessage is not provided');
    }
  } else {
    if (options.port !== undefined) {
      throw new TypeError('options.port must be omitted when options.onMessage is provided');
    }
    if (options.frontendDir !== undefined && typeof options.frontendDir !== 'string') {
      throw new TypeError('options.frontendDir must be a string when provided');
    }
    if (options.maxMessageBodyBytes !== undefined && (
      typeof options.maxMessageBodyBytes !== 'number' ||
      !Number.isFinite(options.maxMessageBodyBytes) ||
      options.maxMessageBodyBytes <= 0
    )) {
      throw new TypeError('options.maxMessageBodyBytes must be a positive finite number when provided');
    }
  }
  if (options.onSizeChanged !== undefined && typeof options.onSizeChanged !== 'function') {
    throw new TypeError('options.onSizeChanged must be a function when provided');
  }
  if (options.contentSizeOptions !== undefined) {
    const cso = options.contentSizeOptions;
    if (cso === null || typeof cso !== 'object') {
      throw new TypeError('options.contentSizeOptions must be an object when provided');
    }
    if (cso.axes !== undefined && !['both', 'width', 'height'].includes(cso.axes)) {
      throw new TypeError("contentSizeOptions.axes must be 'both', 'width' or 'height'");
    }
    if (cso.scrollbarGutter !== undefined && !['auto', 'stable', 'stable-both'].includes(cso.scrollbarGutter)) {
      throw new TypeError("contentSizeOptions.scrollbarGutter must be 'auto', 'stable' or 'stable-both'");
    }
    for (const k of ['minDelta', 'debounceMs', 'suppressDuringResizeMs']) {
      if (cso[k] !== undefined && (typeof cso[k] !== 'number' || cso[k] < 0)) {
        throw new TypeError(`contentSizeOptions.${k} must be a non-negative number`);
      }
    }
    for (const k of ['growOnly', 'shrinkOnly', 'includeBodyMargin', 'emitOnUserResize', 'emitOnProgrammaticResize']) {
      if (cso[k] !== undefined && typeof cso[k] !== 'boolean') {
        throw new TypeError(`contentSizeOptions.${k} must be a boolean`);
      }
    }
  }
  if (options.resizeOptions !== undefined) {
    const ro = options.resizeOptions;
    if (ro === null || typeof ro !== 'object') {
      throw new TypeError('options.resizeOptions must be an object when provided');
    }
    if (ro.axis !== undefined && !['both', 'widthOnly', 'heightOnly', 'none'].includes(ro.axis)) {
      throw new TypeError("resizeOptions.axis must be 'both', 'widthOnly', 'heightOnly' or 'none'");
    }
    for (const group of ['innerSize', 'outerSize']) {
      if (ro[group] === undefined) continue;
      const lim = ro[group];
      if (lim === null || typeof lim !== 'object') {
        throw new TypeError(`resizeOptions.${group} must be an object when provided`);
      }
      for (const k of ['minWidth', 'maxWidth', 'minHeight', 'maxHeight']) {
        if (lim[k] !== undefined && (typeof lim[k] !== 'number' || !Number.isFinite(lim[k]) || lim[k] < 0)) {
          throw new TypeError(`resizeOptions.${group}.${k} must be a non-negative finite number`);
        }
      }
      if (lim.minWidth !== undefined && lim.maxWidth !== undefined && lim.minWidth > lim.maxWidth) {
        throw new RangeError(`resizeOptions.${group}.minWidth must not exceed maxWidth`);
      }
      if (lim.minHeight !== undefined && lim.maxHeight !== undefined && lim.minHeight > lim.maxHeight) {
        throw new RangeError(`resizeOptions.${group}.minHeight must not exceed maxHeight`);
      }
    }
  }

  let win = null;
  let internalServer = null;
  let pendingClose = false;
  const pendingCalls = [];

  const flushPending = () => {
    if (!win) return;
    for (const action of pendingCalls.splice(0)) {
      action();
    }
  };

  const closeInternalServer = () => {
    if (internalServer) {
      internalServer.close();
      internalServer = null;
    }
  };

  const buildWindowOptions = (port) => ({
    ...options,
    port,
    onClose: () => {
      closeInternalServer();
      if (typeof options.onClose === 'function') {
        options.onClose();
      }
    },
  });

  if (hasOnMessage) {
    createInternalServer(options)
      .then(({ server, port }) => {
        internalServer = server;
        win = new GuiWindow(buildWindowOptions(port));
        flushPending();
        if (pendingClose && win) {
          win.close();
        }
      })
      .catch((err) => {
        closeInternalServer();
        // Keep failure visible without crashing from an async throw.
        console.error('[node-gui] Failed to start internal server:', err);
      });
  } else {
    win = new GuiWindow(buildWindowOptions(options.port));
  }

  return {
    /**
     * Close the native window. Safe to call multiple times.
     */
    close() {
      if (win) {
        win.close();
        return;
      }
      pendingClose = true;
      closeInternalServer();
    },
    /**
     * Move the native window to screen coordinates.
     */
    move(left, top) {
      if (win) {
        win.move(left, top);
      } else {
        pendingCalls.push(() => win.move(left, top));
      }
    },
    /**
     * Resize the native window so inner content area is fully visible.
     */
    resize(innerWidth, innerHeight) {
      if (win) {
        win.resize(innerWidth, innerHeight);
      } else {
        pendingCalls.push(() => win.resize(innerWidth, innerHeight));
      }
    },
  };
}

const GuiHandle = {
  /**
   * Get the primary display work area.
   */
  displayArea() {
    return GuiWindow.displayArea();
  },
};

module.exports = { open, GuiHandle };
