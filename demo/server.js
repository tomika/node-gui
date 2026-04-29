'use strict';

const gui = require('..');

const INITIAL_WIDTH = 520;
const INITIAL_HEIGHT = 460;

const win = gui.open({
  width: INITIAL_WIDTH,
  height: INITIAL_HEIGHT,
  frontendDir: __dirname,
  onMessage: async (jsonValue) => {
    if (!jsonValue || typeof jsonValue !== 'object') {
      return { ok: false, error: 'Expected an object message' };
    }

    if (jsonValue.type === 'echo') {
      return {
        ok: true,
        echoed: jsonValue.payload || null,
        receivedAt: new Date().toISOString(),
      };
    }

    return {
      ok: true,
      message: 'Unknown message type',
      input: jsonValue,
    };
  },
  contentSizeOptions: {
    axes: 'height',
    scrollbarGutter: 'stable',
    minDelta: 2,
    // Follow content height live while the user is dragging the width edge.
    suppressDuringResizeMs: 0,
  },
  resizeOptions: {
    axis: 'widthOnly',
  },
  onSizeChanged: (info) => {
    // User can only resize width. The app sizes the window height to
    // exactly fit the content (no scrollbar), clamped to the screen.
    const screen = gui.GuiHandle.displayArea();
    const targetHeight = Math.min(info.contentHeight, screen.height);
    if (Math.abs(targetHeight - info.windowHeight) < 2) return;
    win.resize(info.windowWidth, targetHeight);
  },
  onClose: () => {
    process.exit(0);
  },
});
