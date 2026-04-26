# node-gui

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Native GUI window with an embedded browser control for Node.js applications.
Opens a platform-native webview pointing to `http://localhost:<port>` so your
Node app can ship with a GUI – users never need to open a browser manually.

## Platform support

| Platform | Backend | Extra runtime dependencies |
|----------|---------|---------------------------|
| Linux | GTK 3 + WebKitGTK | `libgtk-3-dev libwebkit2gtk-4.1-dev` |
| macOS | Cocoa + WKWebView | None (system frameworks) |
| Windows | Win32 + WebView2 | Microsoft Edge WebView2 Runtime (pre-installed on Windows 10/11) |

## Install

```bash
npm install node-gui
```

### Linux build prerequisites

```bash
sudo apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev
```

### macOS / Windows

No additional system packages are needed. On Windows the
[WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)
must be present (it ships with Windows 10 1803+ and Windows 11).

## Usage

```js
const http = require('http');
const gui = require('node-gui');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<html><head><title>My App</title></head><body><h1>Hello!</h1></body></html>');
});

server.listen(0, '127.0.0.1', () => {
  const win = gui.open({
    width: 1024,
    height: 768,
    port: server.address().port,
    onClose: () => {
      server.close();
      process.exit(0);
    },
  });
});
```

The window title is automatically synced from the HTML `<title>` element.
Calling `window.close()` in JavaScript closes the native window.

## API

### `gui.open(options)` → `GuiHandle`

Opens a native window with an embedded browser navigating to
`http://localhost:<port>`.

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `width` | `number` | yes | Initial window width in pixels |
| `height` | `number` | yes | Initial window height in pixels |
| `port` | `number` | yes | Localhost port to connect to (1–65535) |
| `onClose` | `function` | no | Called when the window is closed |
| `onSizeChanged` | `function` | no | Called as `(info) => void` whenever the rendered content size, the window size, or related state changes. See [Size tracking](#size-tracking) below. |
| `contentSizeOptions` | `object` | no | Tuning for the content-size observer. See [Size tracking](#size-tracking) below. |
| `resizeOptions` | `object` | no | Limits applied while the user resizes the window. See [Resize limits](#resize-limits) below. |

Returns a `GuiHandle` with these methods:

- `close()` – Requests the native window to close. Safe to call more than once.
- `move(left, top)` – Moves the native window to screen coordinates.
- `resize(innerWidth, innerHeight)` – Resizes the native window so the inner web content area matches the requested size.

Static `GuiHandle` API:

- `gui.GuiHandle.displayArea()` – Returns `{ left, top, width, height }` of the primary display work area.

## Size tracking

`onSizeChanged(info)` is the single notification channel for everything
size-related. The native side injects a small JavaScript observer into every
loaded page that combines a `MutationObserver`, a `ResizeObserver` on
`<html>` / `<body>` / direct children, and a `window` resize listener. The
observer measures the rendered content as

```
max(
  union(boundingRect of body's child elements) + body padding [+ margin],
  documentElement.scrollWidth/Height when overflow is present
)
```

and posts the result back to Node together with the current window /
viewport / scrollbar state. To keep the layout stable while the window
auto-resizes, the observer also sets `documentElement.style.scrollbarGutter`
according to `contentSizeOptions.scrollbarGutter` so a transient scrollbar
cannot trigger an oscillating feedback loop.

`info` is an object with the following fields:

| Field | Type | Meaning |
|-------|------|---------|
| `source` | `'content' \| 'user-resize' \| 'programmatic-resize'` | Why this event fired |
| `userResizing` | `boolean` | `true` while the user is currently dragging the window edges |
| `contentWidth`, `contentHeight` | `number` | Measured content size in CSS px |
| `windowWidth`, `windowHeight` | `number` | `window.innerWidth/Height` at measurement time |
| `viewportWidth`, `viewportHeight` | `number` | `documentElement.clientWidth/Height` (excludes scrollbar gutter) |
| `verticalScrollbar`, `verticalScrollbarSize` | `boolean`, `number` | Whether a vertical scrollbar is consuming layout space, and its width in CSS px |
| `horizontalScrollbar`, `horizontalScrollbarSize` | `boolean`, `number` | Same, for horizontal |
| `devicePixelRatio` | `number` | `window.devicePixelRatio` at measurement time |

### Event sources

- `'content'` – the measured content size changed (initial load, DOM
  mutation, ResizeObserver update). While the user is actively dragging the
  window, `'content'` events are **deferred**, not dropped: the most recent
  measurement is delivered once the drag settles, after
  `contentSizeOptions.suppressDuringResizeMs` ms with no further activity.
- `'user-resize'` – the user finished dragging the window edges. Emitted
  once after the drag settles when `emitOnUserResize` is enabled (default).
  Even when the content size didn't change, this event still carries the
  fresh `windowWidth`/`windowHeight`, so it's a reliable rebase point for
  apps that mirror window dimensions.
- `'programmatic-resize'` – `gui.resize()` settled. Emitted once when
  `emitOnProgrammaticResize` is enabled (default off).

The observer also re-emits when only `windowWidth`/`windowHeight` change
(e.g. when the user drags an edge that doesn't reflow the content).
`info.contentWidth`/`Height` will simply repeat the previous value in that
case, but `info.windowWidth`/`Height` will be current — so `info` is always
a coherent snapshot.

### `contentSizeOptions`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `axes` | `'both' \| 'width' \| 'height'` | `'both'` | Restrict which content axes the observer is allowed to report as changing. The other axis is pinned to its previously reported value. |
| `scrollbarGutter` | `'auto' \| 'stable' \| 'stable-both'` | `'stable'` | Value applied to `documentElement.style.scrollbarGutter`. `'stable'` reserves space for the vertical scrollbar so the page width does not flip when the bar appears or disappears — this prevents the classic feedback loop where auto-resizing a window causes its width to shrink each time a vertical scrollbar flashes. |
| `growOnly` | `boolean` | `false` | Never report a content size below the previously reported size. |
| `shrinkOnly` | `boolean` | `false` | Never report a content size above the previously reported size. |
| `minDelta` | `number` | `1` | Ignore content changes smaller than this many CSS px on each axis. |
| `debounceMs` | `number` | `0` | If > 0, debounce the JS observer with `setTimeout(debounceMs)`. `0` uses a single `requestAnimationFrame`. |
| `includeBodyMargin` | `boolean` | `true` | Whether `<body>` margin contributes to the reported content size. |
| `suppressDuringResizeMs` | `number` | `300` | Defer `'content'` events that arrive within this window of a window resize. The latest measurement is flushed once the resize settles. |
| `emitOnUserResize` | `boolean` | `true` | Emit a `'user-resize'` event after the user finishes dragging. |
| `emitOnProgrammaticResize` | `boolean` | `false` | Emit a `'programmatic-resize'` event after `gui.resize()` settles. |

### Example: auto-resize the window to fit a collapsible region

```js
const win = gui.open({
  width: 800,
  height: 600,
  port,
  contentSizeOptions: {
    axes: 'height',           // only adjust height; never touch width
    scrollbarGutter: 'stable',// stop the scrollbar-flash feedback loop
    minDelta: 2,
  },
  onSizeChanged: (info) => {
    if (info.source !== 'content') return;
    if (info.userResizing) return; // ignore while user is dragging
    win.resize(info.windowWidth, info.contentHeight);
  },
});
```

See [demo/server.js](demo/server.js) for a complete delta-based auto-fit
example that also preserves manual user resizes.

## Resize limits

`resizeOptions` constrains what the user can do while dragging the window
edges. Every field is optional; omit a field to leave that dimension
unconstrained on that side.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `axis` | `'both' \| 'widthOnly' \| 'heightOnly'` | `'both'` | `'widthOnly'` locks height at the initial value; `'heightOnly'` locks width at the initial value. |
| `innerSize` | `SizeLimits` | `{}` | Limits on the **inner** content area in CSS px (matches `window.innerWidth/Height`). |
| `outerSize` | `SizeLimits` | `{}` | Limits on the **outer** window frame including title bar / borders. |

Each `SizeLimits` object accepts any subset of `minWidth`, `maxWidth`,
`minHeight`, `maxHeight` (non-negative numbers). When both `innerSize` and
`outerSize` constrain the same dimension, the more restrictive value wins.

```js
gui.open({
  width: 800, height: 600, port,
  resizeOptions: {
    // Allow only horizontal resize; height is fixed at 600.
    axis: 'widthOnly',
    innerSize: { minWidth: 400 },        // never shrink content below 400 px
    outerSize: { maxWidth: 1600 },       // never grow window beyond 1600 px
  },
});
```

## Standalone packaging

Bundle your app into a single native executable with the included CLI:

```bash
npx node-gui-pack
```

You can also run from outside the project directory:

```bash
npx node-gui-pack /path/to/project
```

Override the configured entry point for a one-off build:

```bash
npx node-gui-pack --project /path/to/project --entry src/main.js
```

Configuration is read from `package.json` under `"node-gui"` → `"pack"`:

```json
{
  "node-gui": {
    "pack": {
      "output": "dist/myapp",
      "main": "src/index.js",
      "hideConsole": true,
      "icon": "assets/icon.svg",
      "exclude": ["src", "test"]
    }
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `output` | package name | Output path (`.exe` added on Windows) |
| `main` | `pkg.main` then `index.js` | Entry-point script |
| `hideConsole` | `true` | Hide console window on Windows |
| `icon` | none | Path to icon file (SVG, PNG, JPG, ICO, or ICNS). Automatically converted to platform format. |
| `exclude` | `[]` | Extra glob patterns to exclude from the bundle |

### Icon handling

The `icon` parameter accepts common image formats and automatically converts them to the required format for each platform:

- **Windows**: Converts to `.ico` format (256×256) and applies it to the packaged app window icon
- **macOS**: Converts to `.icns` format (512×512) and applies it as packaged app icon
- **Linux**: Converts to `.png` format (256×256) and applies it to the packaged app window icon

Supported input formats: **SVG**, **PNG**, **JPG**, **ICO** (Windows), **ICNS** (macOS)

**Note:** Icon conversion requires either:
- **No extra tools** for PNG → ICO conversion on Windows (built-in path)
- **Isolated `jimp` install** (auto-installed by `node-gui` postinstall) for JPG conversion
- **Isolated `@resvg/resvg-js` install** (auto-installed by `node-gui` postinstall) for SVG conversion
- **ImageMagick** (optional) for additional conversion compatibility

If conversion dependencies are not available, the packer will warn and proceed without an icon.

**Note:** `node-gui` installs icon conversion helper packages into an isolated folder (`.node-gui-tools`) and this folder is automatically excluded from packaged executables.

### Runtime requirements

The generated executable requires Node.js to be installed on the target system. If Node.js is not found, the application will display a user-friendly error message with installation instructions.

If the configured main file is missing (or excluded), packaging fails and no executable is produced.

When your app depends on `node-gui` from `node_modules`, the packer automatically excludes
non-runtime files from that dependency (for example `deps/`, `src/`, `scripts/`, `test/`,
`binding.gyp`, Markdown docs, `build/Release/obj`, and Windows debug artifacts like
`*.pdb`, `*.iobj`, `*.ipdb`, `*.lib`, `*.exp`).

The output is a self-extracting executable that requires Node.js on the target machine.

## Building from source

```bash
git clone https://github.com/tomika/node-gui.git
cd node-gui
npm install
npm run build
npm test
```

## Architecture

The package is a [N-API](https://nodejs.org/api/n-api.html) C++ addon built
with [node-addon-api](https://github.com/nicedoc/node-addon-api). The webview
runs on a dedicated background thread so it does not block the Node.js event
loop. Communication between the Node thread and the GUI thread uses N-API
thread-safe functions and platform-specific message posting (GLib idle sources
on Linux, `dispatch_async` on macOS, `PostMessage` on Windows).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)

## License

MIT