import http from 'node:http';
import httpProxy from 'http-proxy';
import { PassThrough } from 'node:stream';

const PORT = process.env.PORT || 3000;
const TARGET_BASE_URL = process.env.TARGET_BASE_URL || 'https://openrouter.ai';
const SHARED_SECRET = process.env.RELAY_SHARED_SECRET;
// دیباگ موقت: هدرهای هر درخواست را چاپ می‌کند (Authorization/secret را کامل نشان نمی‌دهد)
// تا بشود دید واقعاً چه HTTP-Referer/X-Title‌ای از بک‌اند ایران به اینجا می‌رسد.
const LOG_HEADERS = process.env.LOG_HEADERS === 'true';
// دیباگ موقت: بدنه‌ی هر درخواست (مدل + پرامپت/messages) را چاپ می‌کند، برای تشخیص اینکه
// درخواست واقعاً تا اینجا (سرور خارج از ایران) رسیده یا نه و دقیقاً چه چیزی فرستاده شده.
const LOG_PROMPTS = process.env.LOG_PROMPTS !== 'false';
const LOG_PROMPT_MAX_CHARS = 4000;

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
// Also strip everything Traefik added in front of us that would reveal the
// original (Iran-based) client IP to the upstream — the whole point of this
// relay is that the upstream should only ever see this box's own IP.
const HOP_HEADERS_TO_STRIP = [
  'x-relay-secret',
  'x-forwarded-for',
  'x-real-ip',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-forwarded-server',
];

proxy.on('proxyReq', (proxyReq) => {
  for (const header of HOP_HEADERS_TO_STRIP) {
    proxyReq.removeHeader(header);
  }
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

function redact(value) {
  if (!value) return value;
  return value.length > 12 ? `${value.slice(0, 8)}...(${value.length} chars)` : '***';
}

function logHeaders(req) {
  if (!LOG_HEADERS) return;
  const safe = { ...req.headers };
  if (safe.authorization) safe.authorization = redact(safe.authorization);
  if (safe['x-relay-secret']) safe['x-relay-secret'] = redact(safe['x-relay-secret']);
  console.log(`relay: ${req.method} ${req.url} headers=`, safe);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function truncate(text) {
  return text.length > LOG_PROMPT_MAX_CHARS
    ? `${text.slice(0, LOG_PROMPT_MAX_CHARS)}...(${text.length} chars total)`
    : text;
}

function logPrompt(req, bodyBuffer) {
  if (!LOG_PROMPTS || bodyBuffer.length === 0) return;
  let body;
  try {
    body = JSON.parse(bodyBuffer.toString('utf8'));
  } catch {
    console.log(`relay: ${req.method} ${req.url} body=<non-JSON, ${bodyBuffer.length} bytes>`);
    return;
  }
  const { model, messages, prompt } = body;
  console.log(
    `relay: ${req.method} ${req.url} model=${model ?? '?'} prompt=${truncate(
      JSON.stringify(messages ?? prompt ?? body),
    )}`,
  );
}

const server = http.createServer(async (req, res) => {
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

  logHeaders(req);

  // بدنه را کامل می‌خوانیم تا هم بشود پرامپت را لاگ کرد هم بدون تغییر به OpenRouter پاس داد
  // (http-proxy وقتی گزینه‌ی buffer داده شود، به‌جای خودِ req از این استریم می‌خواند).
  let bodyBuffer;
  try {
    bodyBuffer = await readBody(req);
  } catch (err) {
    console.error('relay: failed to read request body:', err.message);
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad_request' }));
    return;
  }

  logPrompt(req, bodyBuffer);

  const buffer = new PassThrough();
  buffer.end(bodyBuffer);
  proxy.web(req, res, { buffer });
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
  console.log(
    `relay: config LOG_HEADERS=${LOG_HEADERS} (raw=${JSON.stringify(
      process.env.LOG_HEADERS,
    )}) LOG_PROMPTS=${LOG_PROMPTS} (raw=${JSON.stringify(process.env.LOG_PROMPTS)})`,
  );
});
