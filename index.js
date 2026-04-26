'use strict';

const path = require('path');

let binding;
try {
  binding = require(path.join(__dirname, 'build', 'Release', 'node_gui.node'));
} catch {
  binding = require(path.join(__dirname, 'build', 'Debug', 'node_gui.node'));
}

const { GuiWindow } = binding;

/**
 * Open a native window with an embedded browser control pointing to
 * http://localhost:<port>.
 *
 * @param {object}  options
 * @param {number}  options.width    - Initial window width in pixels.
 * @param {number}  options.height   - Initial window height in pixels.
 * @param {number}  options.port     - Port number on localhost to navigate to.
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
  if (typeof options.port !== 'number' || options.port <= 0 || options.port > 65535) {
    throw new TypeError('options.port must be a number between 1 and 65535');
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
    if (ro.axis !== undefined && !['both', 'widthOnly', 'heightOnly'].includes(ro.axis)) {
      throw new TypeError("resizeOptions.axis must be 'both', 'widthOnly' or 'heightOnly'");
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

  const win = new GuiWindow(options);

  return {
    /**
     * Close the native window. Safe to call multiple times.
     */
    close() {
      win.close();
    },
    /**
     * Move the native window to screen coordinates.
     */
    move(left, top) {
      win.move(left, top);
    },
    /**
     * Resize the native window so inner content area is fully visible.
     */
    resize(innerWidth, innerHeight) {
      win.resize(innerWidth, innerHeight);
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
