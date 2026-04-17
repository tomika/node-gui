# node-gui

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
const gui = require('node-gui');

// Open a native window that loads http://localhost:3000
const win = gui.open({
  width: 1024,
  height: 768,
  port: 3000,
  title: 'My App',       // optional, defaults to "node-gui"
  onClose: () => {        // optional callback
    console.log('Window closed');
    process.exit(0);
  },
});

// Programmatically close the window (safe to call multiple times)
win.close();
```

### API

#### `gui.open(options)` → `{ close() }`

Opens a native window with an embedded browser navigating to
`http://localhost:<port>`.

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `width` | `number` | yes | Initial window width in pixels |
| `height` | `number` | yes | Initial window height in pixels |
| `port` | `number` | yes | Localhost port to connect to (1–65535) |
| `title` | `string` | no | Window title (default: `"node-gui"`) |
| `onClose` | `function` | no | Called when the window is closed |

Returns an object with a **`close()`** method that requests the native window
to close. It is safe to call `close()` more than once.

## Architecture

The package is a [N-API](https://nodejs.org/api/n-api.html) C++ addon built
with [node-addon-api](https://github.com/nicedoc/node-addon-api).  The webview
runs on a dedicated background thread so it does not block the Node.js event
loop.  Communication between the Node thread and the GUI thread uses N-API
thread-safe functions and platform-specific message posting (GLib idle sources
on Linux, `dispatch_async` on macOS, `PostMessage` on Windows).

## License

MIT