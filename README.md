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

### `gui.open(options)` → `{ close() }`

Opens a native window with an embedded browser navigating to
`http://localhost:<port>`.

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `width` | `number` | yes | Initial window width in pixels |
| `height` | `number` | yes | Initial window height in pixels |
| `port` | `number` | yes | Localhost port to connect to (1–65535) |
| `onClose` | `function` | no | Called when the window is closed |

Returns an object with a **`close()`** method that requests the native window
to close. It is safe to call `close()` more than once.

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
      "icon": "assets/icon.ico",
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
| `icon` | none | Path to `.ico` file (Windows only) |
| `exclude` | `[]` | Extra glob patterns to exclude from the bundle |

If the configured main file is missing (or excluded), packaging fails and no executable is produced.

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