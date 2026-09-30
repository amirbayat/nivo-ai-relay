import http from 'node:http';
import httpProxy from 'http-proxy';
import { PassThrough } from 'node:stream';

const PORT = process.env.PORT || 3000;
const DEFAULT_TARGET_BASE_URL = process.env.TARGET_BASE_URL || 'https://openrouter.ai';
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

// این ریله دیگر فقط برای OpenRouter نیست — یک reverse-proxy چندمقصده شده: با یک prefix روی
// مسیر، درخواست به هر upstream خارج از ایران که بک‌اند نیوو لازم دارد فوروارد می‌شود (اضافه‌شده
// برای فیچر «ویرایش ویدیو» — docs/PRD-video-edit-omni-kie.md §۳ — که به دو upstream جدای
// Kie.ai نیاز دارد: خودِ API و دامنه‌ی جدای آپلود فایل). بدون prefix (رفتار قبلی، دست‌نخورده)
// یعنی OpenRouter — پس تنظیمات پروداکشن فعلی نیازی به تغییر ندارند. اضافه‌کردن provider بعدی
// یعنی فقط یک ردیف جدید اینجا + یکی‌دو env var — بدون دیپلوی relay/دامنه‌ی جدا، بدون تغییر Caddyfile
// (هنوز فقط یک host روی این پورت پروکسی می‌شود).
const ROUTES = [
  // طولانی‌ترین prefix اول — وگرنه '/kie-upload/...' اشتباهی با prefix کوتاه‌تر '/kie' مچ می‌شود
  { prefix: '/kie-upload', target: process.env.KIE_UPLOAD_TARGET_BASE_URL },
  { prefix: '/kie', target: process.env.KIE_TARGET_BASE_URL },
  // docs/PRD-telegram-bot-channel.md — ایران تلگرام را فیلتر می‌کند؛ فراخوانی خروجی بک‌اند به
  // api.telegram.org (ارسال پاسخ/دانلود فایل) باید از همین relay رد شود، دقیقاً مثل OpenRouter/Kie
  { prefix: '/telegram', target: process.env.TELEGRAM_TARGET_BASE_URL },
].filter((route) => route.target);

// مسیر واقعی درخواست را به upstream/مسیر-باقی‌مانده‌ی درست ترجمه می‌کند — مثلاً با
// KIE_TARGET_BASE_URL=https://api.kie.ai، درخواست به /kie/api/v1/jobs/createTask باید
// /api/v1/jobs/createTask را به api.kie.ai بزند، نه /kie/api/v1/jobs/createTask را
function resolveTarget(url) {
  for (const route of ROUTES) {
    if (url === route.prefix || url.startsWith(`${route.prefix}/`)) {
      return { target: route.target, forwardedPath: url.slice(route.prefix.length) || '/' };
    }
  }
  return { target: DEFAULT_TARGET_BASE_URL, forwardedPath: url };
}

const proxy = httpProxy.createProxyServer({
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

proxy.on('error', (err, req, res) => {
  console.error(`relay: upstream error for ${redactUrl(req._relayOriginalUrl ?? req.url)}:`, err.message);
  if (res.writeHead && !res.headersSent) {
    res.writeHead(502, { 'content-type': 'application/json' });
  }
  res.end(JSON.stringify({ error: 'bad_gateway' }));
});

// این لاگ همون چیزی است که قبلاً فقط با curl دستی می‌شد فهمید: این درخواست واقعاً کدوم
// route را گرفته (مثلاً /telegram) و از upstream چه status codeای برگشته — بدون این، تنها
// راه فهمیدن «آیا این پراسس کد جدید را دارد یا افتاده روی fallback پیش‌فرض» یک curl دستی بود.
proxy.on('proxyRes', (proxyRes, req) => {
  console.log(
    `relay: <- ${proxyRes.statusCode} ${req.method} ${redactUrl(req._relayOriginalUrl ?? req.url)} -> ${req._relayTarget ?? '?'}`,
  );
});

function isAuthorized(req) {
  return req.headers['x-relay-secret'] === SHARED_SECRET;
}

function redact(value) {
  if (!value) return value;
  return value.length > 12 ? `${value.slice(0, 8)}...(${value.length} chars)` : '***';
}

// مسیر تلگرام (/telegram/bot<TOKEN>/...) خودِ توکن بات را توی URL دارد — قبل از این تابع
// همه‌ی لاگ‌های زیر (headers/prompt/routing/response) این توکن را عیناً چاپ می‌کردند.
// همون الگوی redact بالا را برای URL هم اعمال می‌کنیم.
function redactUrl(url) {
  return url.replace(/\/bot\d+:[^/]+/, '/bot***');
}

function logHeaders(req) {
  if (!LOG_HEADERS) return;
  const safe = { ...req.headers };
  if (safe.authorization) safe.authorization = redact(safe.authorization);
  if (safe['x-relay-secret']) safe['x-relay-secret'] = redact(safe['x-relay-secret']);
  console.log(`relay: ${req.method} ${redactUrl(req.url)} headers=`, safe);
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
    `relay: ${req.method} ${redactUrl(req.url)} model=${model ?? '?'} prompt=${truncate(
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

  const originalUrl = req.url;
  const { target, forwardedPath } = resolveTarget(req.url);
  console.log(`relay: -> ${target}${redactUrl(forwardedPath)}`);
  req.url = forwardedPath; // http-proxy فقط req.url رو به انتهای target اضافه می‌کند
  // برای proxyRes/error هندلرهای بالا نگه می‌داریم — آن‌ها req.url رو بعد از rewrite می‌بینند
  req._relayOriginalUrl = originalUrl;
  req._relayTarget = target;

  const buffer = new PassThrough();
  buffer.end(bodyBuffer);
  proxy.web(req, res, { target, buffer });
});

// Not used by OpenRouter's current REST/SSE endpoints, but kept so a future
// websocket-based endpoint isn't silently dropped by this relay.
server.on('upgrade', (req, socket, head) => {
  if (!isAuthorized(req)) {
    socket.destroy();
    return;
  }
  const { target, forwardedPath } = resolveTarget(req.url);
  req.url = forwardedPath;
  proxy.ws(req, socket, head, { target });
});

server.listen(PORT, () => {
  console.log(`openrouter-relay listening on :${PORT} -> default=${DEFAULT_TARGET_BASE_URL}`);
  for (const route of ROUTES) {
    console.log(`relay: route ${route.prefix}/* -> ${route.target}`);
  }
  console.log(
    `relay: config LOG_HEADERS=${LOG_HEADERS} (raw=${JSON.stringify(
      process.env.LOG_HEADERS,
    )}) LOG_PROMPTS=${LOG_PROMPTS} (raw=${JSON.stringify(process.env.LOG_PROMPTS)})`,
  );
});
