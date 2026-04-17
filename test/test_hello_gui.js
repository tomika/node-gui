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
    .form-group {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 1.5rem;
    }
    label { font-size: 1.1rem; }
    input[type="text"] {
      padding: 10px 16px;
      font-size: 1.1rem;
      border: 2px solid #fff;
      border-radius: 8px;
      background: rgba(255,255,255,0.15);
      color: #fff;
      outline: none;
    }
    input[type="text"]::placeholder { color: rgba(255,255,255,0.6); }
    input[type="text"]:focus { background: rgba(255,255,255,0.25); }
    .buttons { display: flex; gap: 12px; }
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
  <div class="form-group">
    <label for="name">Name:</label>
    <input type="text" id="name" placeholder="Enter your name">
  </div>
  <div class="buttons">
    <button onclick="sayHello()">Say Hello</button>
    <button onclick="window.close()">Close Window</button>
  </div>
  <script>
    async function sayHello() {
      const name = document.getElementById('name').value.trim();
      if (!name) { alert('Please enter a name.'); return; }
      const res = await fetch('/hello', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      const data = await res.json();
      alert(data.message);
    }
  </script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/hello') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let name;
      try { name = JSON.parse(body).name; } catch (_) { name = ''; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Hello ' + name + '!' }));
    });
    return;
  }
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
