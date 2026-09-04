import http from 'node:http';
import httpProxy from 'http-proxy';

const PORT = process.env.PORT || 3000;
const TARGET_BASE_URL = process.env.TARGET_BASE_URL || 'https://openrouter.ai';
const SHARED_SECRET = process.env.RELAY_SHARED_SECRET;

if (!SHARED_SECRET) {
  console.error('RELAY_SHARED_SECRET env var is required — refusing to start as an open relay.');
  process.exit(1);
}

const proxy = httpProxy.createProxyServer({
  target: TARGET_BASE_URL,
  changeOrigin: true,
  secure: true,
});

// Strip the auth header before it ever reaches OpenRouter — it's ours, not theirs.
proxy.on('proxyReq', (proxyReq) => {
  proxyReq.removeHeader('x-relay-secret');
});

proxy.on('error', (err, _req, res) => {
  console.error('relay: upstream error:', err.message);
  if (res.writeHead && !res.headersSent) {
    res.writeHead(502, { 'content-type': 'application/json' });
  }
  res.end(JSON.stringify({ error: 'bad_gateway' }));
});

function isAuthorized(req) {
  return req.headers['x-relay-secret'] === SHARED_SECRET;
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (!isAuthorized(req)) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden' }));
    return;
  }

  proxy.web(req, res);
});

// Not used by OpenRouter's current REST/SSE endpoints, but kept so a future
// websocket-based endpoint isn't silently dropped by this relay.
server.on('upgrade', (req, socket, head) => {
  if (!isAuthorized(req)) {
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head);
});

server.listen(PORT, () => {
  console.log(`openrouter-relay listening on :${PORT} -> ${TARGET_BASE_URL}`);
});
