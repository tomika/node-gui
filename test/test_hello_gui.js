'use strict';

// test/test_hello_gui.js – Opens a real native GUI window showing "Hello World".
// Run with: node test/test_hello_gui.js
// The window auto-closes after 3 seconds.

const http = require('http');
const gui = require('..');

const HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Hello World</title>
  <style>
    body {
      margin: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #fff;
    }
    h1 { font-size: 3rem; margin-bottom: 1.5rem; }
    button {
      padding: 12px 32px;
      font-size: 1.1rem;
      border: 2px solid #fff;
      border-radius: 8px;
      background: transparent;
      color: #fff;
      cursor: pointer;
      transition: background 0.2s, color 0.2s;
    }
    button:hover { background: #fff; color: #764ba2; }
  </style>
</head>
<body>
  <h1>Hello World!</h1>
  <button onclick="window.close()">Close Window</button>
</body>
</html>`;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(HTML);
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  console.log(`HTTP server listening on http://127.0.0.1:${port}`);

  const win = gui.open({
    width: 640,
    height: 480,
    port,

    onClose: () => {
      console.log('Window closed.');
      server.close();
    },
  });
});
