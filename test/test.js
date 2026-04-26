'use strict';

const assert = require('assert');
const path = require('path');

// ---- Unit tests for the JS-level validation (no native build needed) ----

// We test the JS wrapper's input validation without actually loading the
// native addon, since the test environment may not have a display server.

const indexPath = path.join(__dirname, '..', 'index.js');

// Stub the native binding so that tests run without the compiled addon.
// We intercept require() for the binding and return a mock.
const Module = require('module');
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  // Intercept attempts to load the native .node binary
  if (request.endsWith('node_gui.node')) {
    // Return a path that we will handle via _cache below
    return '__mock_node_gui__';
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

// Inject a mock module
require.cache['__mock_node_gui__'] = {
  id: '__mock_node_gui__',
  filename: '__mock_node_gui__',
  loaded: true,
  exports: {
    GuiWindow: class MockGuiWindow {
      constructor(opts) {
        this._opts = opts;
        this._closed = false;
        // Invoke onClose asynchronously to simulate real behavior
        if (typeof opts.onClose === 'function') {
          this._onCloseCallback = opts.onClose;
        }
      }
      close() {
        if (!this._closed) {
          this._closed = true;
          if (this._onCloseCallback) {
            setImmediate(this._onCloseCallback);
          }
        }
      }
    },
  },
};

// Now load index.js – it will pick up our mock
const gui = require(indexPath);

let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('node-gui tests\n');

// -- Validation tests --

test('open() throws without options', () => {
  assert.throws(() => gui.open(), /options must be an object/);
});

test('open() throws with non-object options', () => {
  assert.throws(() => gui.open('bad'), /options must be an object/);
});

test('open() throws without width', () => {
  assert.throws(
    () => gui.open({ height: 600, port: 3000 }),
    /width must be a positive number/
  );
});

test('open() throws with invalid width', () => {
  assert.throws(
    () => gui.open({ width: -1, height: 600, port: 3000 }),
    /width must be a positive number/
  );
});

test('open() throws without height', () => {
  assert.throws(
    () => gui.open({ width: 800, port: 3000 }),
    /height must be a positive number/
  );
});

test('open() throws with invalid height', () => {
  assert.throws(
    () => gui.open({ width: 800, height: 0, port: 3000 }),
    /height must be a positive number/
  );
});

test('open() throws without port', () => {
  assert.throws(
    () => gui.open({ width: 800, height: 600 }),
    /port must be a number/
  );
});

test('open() throws with port out of range', () => {
  assert.throws(
    () => gui.open({ width: 800, height: 600, port: 70000 }),
    /port must be a number between 1 and 65535/
  );
});

test('open() returns object with close method', () => {
  const win = gui.open({ width: 800, height: 600, port: 3000 });
  assert.strictEqual(typeof win.close, 'function');
  win.close();
});

test('close() can be called multiple times safely', () => {
  const win = gui.open({ width: 800, height: 600, port: 3000 });
  win.close();
  win.close(); // should not throw
});

test('onClose callback is invoked when window is closed', () => {
  return new Promise((resolve) => {
    const win = gui.open({
      width: 800,
      height: 600,
      port: 3000,
      onClose: () => {
        resolve();
      },
    });
    win.close();
  });
});

test('open() throws when contentSizeOptions is not an object', () => {
  assert.throws(
    () => gui.open({ width: 800, height: 600, port: 3000, contentSizeOptions: 'bad' }),
    /contentSizeOptions must be an object/
  );
});

test('open() throws on invalid contentSizeOptions.axes', () => {
  assert.throws(
    () => gui.open({
      width: 800, height: 600, port: 3000,
      contentSizeOptions: { axes: 'diagonal' },
    }),
    /axes must be 'both', 'width' or 'height'/
  );
});

test('open() throws on invalid contentSizeOptions.scrollbarGutter', () => {
  assert.throws(
    () => gui.open({
      width: 800, height: 600, port: 3000,
      contentSizeOptions: { scrollbarGutter: 'invisible' },
    }),
    /scrollbarGutter must be 'auto', 'stable' or 'stable-both'/
  );
});

test('open() throws when contentSizeOptions.minDelta is negative', () => {
  assert.throws(
    () => gui.open({
      width: 800, height: 600, port: 3000,
      contentSizeOptions: { minDelta: -1 },
    }),
    /minDelta must be a non-negative number/
  );
});

test('open() throws when contentSizeOptions.growOnly is not a boolean', () => {
  assert.throws(
    () => gui.open({
      width: 800, height: 600, port: 3000,
      contentSizeOptions: { growOnly: 1 },
    }),
    /growOnly must be a boolean/
  );
});

test('open() accepts valid contentSizeOptions', () => {
  const win = gui.open({
    width: 800, height: 600, port: 3000,
    contentSizeOptions: {
      axes: 'height',
      scrollbarGutter: 'stable',
      growOnly: false,
      shrinkOnly: false,
      minDelta: 2,
      debounceMs: 50,
      includeBodyMargin: true,
      suppressDuringResizeMs: 250,
      emitOnUserResize: true,
      emitOnProgrammaticResize: false,
    },
  });
  win.close();
});

test('open() throws when resizeOptions is not an object', () => {
  assert.throws(
    () => gui.open({ width: 800, height: 600, port: 3000, resizeOptions: 'bad' }),
    /resizeOptions must be an object/
  );
});

test('open() throws on invalid resizeOptions.axis', () => {
  assert.throws(
    () => gui.open({
      width: 800, height: 600, port: 3000,
      resizeOptions: { axis: 'diagonal' },
    }),
    /resizeOptions\.axis/
  );
});

test('open() throws on negative innerSize.minWidth', () => {
  assert.throws(
    () => gui.open({
      width: 800, height: 600, port: 3000,
      resizeOptions: { innerSize: { minWidth: -1 } },
    }),
    /resizeOptions\.innerSize\.minWidth/
  );
});

test('open() throws when innerSize.minWidth > maxWidth', () => {
  assert.throws(
    () => gui.open({
      width: 800, height: 600, port: 3000,
      resizeOptions: { innerSize: { minWidth: 500, maxWidth: 200 } },
    }),
    /minWidth must not exceed maxWidth/
  );
});

test('open() accepts valid resizeOptions with partial limits', () => {
  const win = gui.open({
    width: 800, height: 600, port: 3000,
    resizeOptions: {
      axis: 'heightOnly',
      innerSize: { minHeight: 200 },
      outerSize: { maxWidth: 1600 },
    },
  });
  win.close();
});

console.log(`\n${passed} tests passed`);
