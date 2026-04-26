'use strict';

const path = require('path');
const gui = require('..');

const INITIAL_WIDTH = 520;
const INITIAL_HEIGHT = 460;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 1400;

// Last content height we observed. We act on the *delta* between
// successive content measurements so that a manual user resize is not
// reverted: we only add (or remove) the amount the content itself
// grew (or shrank).
let lastContentHeight = -1;

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
    // Only adjust the window height; never touch its width.
    axes: 'height',
    // Stop the scrollbar-flash feedback loop while we're resizing.
    scrollbarGutter: 'stable',
    // Filter tiny sub-pixel jitter.
    minDelta: 2,
    // While the user is dragging, defer 'content' events. Once the drag
    // ends we rebase to the user's chosen height (see the 'user-resize'
    // branch below) so we never snap back.
    suppressDuringResizeMs: 250,
    emitOnUserResize: true,
    emitOnProgrammaticResize: false,
  },
  onSizeChanged: (info) => {
    const h = info.contentHeight;
    // User finished resizing manually. Don't override their choice;
    // just rebase so future content deltas are applied on top of it.
    if (info.source === 'user-resize') {
      lastContentHeight = h;
      return;
    }
    if (info.source !== 'content') return;
    if (info.userResizing) return;

    const currentWinHeight = info.windowHeight || INITIAL_HEIGHT;

    // Seed the baseline on the first event with the current inner-window
    // height so the very first delta closes the gap between content and
    // window (i.e. the initial layout fits without manual interaction).
    if (lastContentHeight < 0) {
      lastContentHeight = currentWinHeight;
    }

    const delta = h - lastContentHeight;
    if (Math.abs(delta) < 2) return;
    lastContentHeight = h;

    const targetHeight = Math.max(
      MIN_HEIGHT,
      Math.min(MAX_HEIGHT, currentWinHeight + delta)
    );
    if (Math.abs(targetHeight - currentWinHeight) < 2) return;

    // Preserve the user's current width; only the height follows content.
    win.resize(info.windowWidth || INITIAL_WIDTH, targetHeight);
  },
  onClose: () => {
    process.exit(0);
  },
});
