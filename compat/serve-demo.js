#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const DEMO_DIR = path.join(__dirname, '..', 'demo');

const server = http.createServer((req, res) => {
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Route requests to demo directory
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(DEMO_DIR, filePath);

  // Security: prevent directory traversal
  const realPath = path.resolve(filePath);
  if (!realPath.startsWith(path.resolve(DEMO_DIR))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found: ' + req.url);
      return;
    }

    // Set content type
    let contentType = 'text/plain';
    if (filePath.endsWith('.html')) {
      contentType = 'text/html';
    } else if (filePath.endsWith('.js')) {
      contentType = 'application/javascript';
    } else if (filePath.endsWith('.json')) {
      contentType = 'application/json';
    } else if (filePath.endsWith('.svg')) {
      contentType = 'image/svg+xml';
    } else if (filePath.endsWith('.css')) {
      contentType = 'text/css';
    }

    res.setHeader('Content-Type', contentType);
    res.writeHead(200);
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Demo server running at http://localhost:${PORT}`);
});
