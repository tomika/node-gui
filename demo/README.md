# node-gui collapsible demo

A small app that opens a native window with four collapsible sections. The
native window's **height** automatically follows the rendered content height
when sections are expanded or collapsed; the **width** is preserved.

## Run

From the repository root (after `npm install` and `npm run build`):

```bash
node demo/server.js
```

Or:

```bash
cd demo
npm start
```

## How it works

The demo passes these options to `gui.open`:

```js
contentSizeOptions: {
  axes: 'height',           // only the height axis is reported
  scrollbarGutter: 'stable',// avoid scrollbar-flash feedback loops
  minDelta: 2,
  suppressDuringResizeMs: 250,
  emitOnUserResize: false,
  emitOnProgrammaticResize: false,
}
```

In `onSizeChanged(info)` the demo:

- on `info.source === 'user-resize'`, rebases its baseline content height
  to `info.contentHeight` so future content deltas are applied on top of
  the user's chosen window size (manual resizes are never reverted)
- on `info.source === 'content'` (and `!info.userResizing`), applies the
  delta `info.contentHeight - lastContentHeight` to the current
  `info.windowHeight`, clamped to `[120, 1400]` px
- calls `win.resize(info.windowWidth, targetHeight)` to keep the user's
  current width and only update the height
