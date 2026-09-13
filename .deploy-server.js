// 临时部署辅助：在 127.0.0.1:8123 提供 worker.js，带 CORS
const http = require('http');
const fs = require('fs');

http.createServer((req, res) => {
  if (req.url === '/worker.js') {
    const content = fs.readFileSync('d:/Product/BiliDown-web/worker.js');
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(content);
    return;
  }
  res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
  res.end('not found');
}).listen(8123, '127.0.0.1', () => {
  console.log('serving worker.js on http://127.0.0.1:8123/worker.js');
});