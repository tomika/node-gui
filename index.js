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
 * @param {function} [options.onContentSize] - Callback invoked when web content
 *                                            size changes: (width, height).
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
  if (options.onContentSize !== undefined && typeof options.onContentSize !== 'function') {
    throw new TypeError('options.onContentSize must be a function when provided');
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
