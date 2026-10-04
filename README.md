# openrouter-relay

یک reverse proxy کوچک که روی سروری خارج از ایران (مثلاً هلند) اجرا می‌شود، درخواست‌های
`nivo-ai-backend` را با دامنه/IP خودش به OpenRouter می‌زند و پاسخ (شامل استریم SSE چت) را
بدون تغییر برمی‌گرداند. از دید OpenRouter، این سرور دارد درخواست می‌زند — نه بک‌اند اصلی.

فقط با یک secret مشترک کار می‌کند (هدر `X-Relay-Secret`) تا کسی جز بک‌اند خودتان نتواند
از این دامنه به‌عنوان open proxy سوءاستفاده کند.

## دیپلوی روی سرور هلند

1. یک دامنه/ساب‌دامنه بسازید (مثلاً `relay.nivoai.site`) و رکورد A آن را به IP سرور بزنید.
2. `Caddyfile` را ویرایش کنید و `relay.nivoai.site` را با دامنه‌ی واقعی‌تان جایگزین کنید.
3. یک secret تصادفی طولانی بسازید:
   ```bash
   openssl rand -hex 32
   ```
4. روی سرور:
   ```bash
   git clone <this-folder-or-repo> openrouter-relay
   cd openrouter-relay
   echo "RELAY_SHARED_SECRET=<مقدار بالا>" > .env
   docker compose up -d --build
   ```
   Caddy خودکار گواهی TLS (Let's Encrypt) برای دامنه می‌گیرد — فقط پورت‌های ۸۰/۴۴۳ باید باز باشند.
5. تست:
   ```bash
   curl https://relay.nivoai.site/healthz          # -> ok
   curl -H "X-Relay-Secret: <secret>" https://relay.nivoai.site/api/v1/models
   ```

## وصل‌کردن به nivo-ai-backend

در env بک‌اند اصلی (پروداکشن، اپ Darkube):

```
OPENROUTER_BASE_URL=https://relay.nivoai.site/api/v1
OPENROUTER_RELAY_SECRET=<همان secret بالا>
```

`ai-provider.service.ts` این دو مقدار را می‌خواند و به‌صورت خودکار هدر `X-Relay-Secret` را به
هر درخواست OpenRouter اضافه می‌کند — نیازی به تغییر دیگری در کد بک‌اند نیست.
با این تنظیم، `OPENROUTER_PROXY_URL` (پروکسی forward قبلی) دیگر لازم نیست و می‌تواند خالی بماند.

## چندمقصدی — اضافه‌کردن Kie.ai (یا هر provider دیگر) بدون relay/دامنه‌ی جدا

از این نسخه به بعد، این relay تک‌مقصده نیست — با یک prefix روی مسیر درخواست، می‌تواند به چند
upstream مختلف فوروارد کند، همه از پشت همون یک دامنه/سرور. برای فیچر «ویرایش ویدیو»
(docs/PRD-video-edit-omni-kie.md §۳) به دو upstream جدای Kie.ai نیاز است — خودِ API و دامنه‌ی
جدای آپلود فایل:

```
KIE_TARGET_BASE_URL=https://api.kie.ai
KIE_UPLOAD_TARGET_BASE_URL=https://kieai.redpandaai.co
```

با این دو env var روی همین سرور (بدون تغییر Caddyfile — هنوز فقط یک host/پورت است)، بک‌اند اصلی
باید این‌ها را ست کند:

```
KIE_API_KEY=<کلید واقعی Kie.ai>
KIE_BASE_URL=https://relay.nivoai.site/kie
KIE_UPLOAD_BASE_URL=https://relay.nivoai.site/kie-upload
KIE_RELAY_SECRET=<همان RELAY_SHARED_SECRET>
```

یعنی درخواست به `{KIE_BASE_URL}/api/v1/jobs/createTask` واقعاً روی این relay به
`/kie/api/v1/jobs/createTask` می‌رسد، prefix `/kie` کنار گذاشته می‌شود، و مسیر باقی‌مانده
(`/api/v1/jobs/createTask`) به `KIE_TARGET_BASE_URL` زده می‌شود — دقیقاً همون مکانیزمی که
OpenRouter از قبل با prefix خالی (پیش‌فرض) استفاده می‌کند. `Authorization: Bearer <KIE_API_KEY>`
دست‌نخورده رد می‌شود (فقط `X-Relay-Secret` قبل از رسیدن به upstream حذف می‌شود، دقیقاً مثل
مسیر OpenRouter).

بدون ست‌کردن این دو env var روی این سرور، مسیرهای `/kie`/`/kie-upload` اصلاً وجود ندارند و
رفتار فعلی OpenRouter کاملاً دست‌نخورده می‌ماند — این یک تغییر additive است، نه یک migration.

## بات تلگرام — همین الگو، بدون relay/دامنه‌ی جدا

ایران تلگرام را فیلتر می‌کند. برخلاف فرضِ اولیه‌ی این پروژه («وبهوک ورودی چون از بیرون ایران
شروع می‌شود مشکلی ندارد» — نگاه کنید `docs/PRD-telegram-bot-channel.md` §کشف ۱۴۰۵/۰۷/۰۹)، تست
واقعی بعدی نشان داد اتصال inbound تلگرام به سرور ایران هم فیلتر/مسدود می‌شود، نه فقط outbound
بک‌اند به تلگرام. پس **هر دو جهت** ارتباط با تلگرام باید از این relay رد شوند.

### جهت خروجی (بک‌اند ایران -> تلگرام): ارسال پیام/دانلود فایل

روی سرور relay:
```
TELEGRAM_TARGET_BASE_URL=https://api.telegram.org
```

روی env بک‌اند اصلی:
```
TELEGRAM_API_BASE_URL=https://relay.nivoai.site/telegram
TELEGRAM_RELAY_SECRET=<همان RELAY_SHARED_SECRET>
```

درخواست به `{TELEGRAM_API_BASE_URL}/bot<TOKEN>/sendMessage` روی relay به
`/telegram/bot<TOKEN>/sendMessage` می‌رسد، prefix `/telegram` کنار گذاشته می‌شود، و مسیر
باقی‌مانده (`/bot<TOKEN>/sendMessage`) به `TELEGRAM_TARGET_BASE_URL` زده می‌شود — همان مکانیزم
Kie.ai بالا. بدون ست‌کردن `TELEGRAM_TARGET_BASE_URL` روی این سرور، مسیر `/telegram` اصلاً وجود
ندارد و بقیه‌ی relay دست‌نخورده می‌ماند.

### جهت ورودی (تلگرام -> relay -> بک‌اند ایران): وبهوک

این مسیر شکل دیگری دارد چون خودِ تلگرام (نه بک‌اند ما) این درخواست را می‌زند — هدر
`X-Relay-Secret` را نمی‌فرستد، پس این مسیر خاص از چک secret این relay معاف است (امنیت با
`secret_token` تلگرام تأمین می‌شود که بک‌اند از قبل چک می‌کند؛ `server.js` فقط بی‌طرف فوروارد
می‌کند). یک مسیر ثابت است، نه prefix — `/telegram-webhook`.

روی سرور relay:
```
TELEGRAM_WEBHOOK_TARGET_URL=https://api.nivoai.ir/api/v1/v2/telegram/webhook
```
(آدرس کامل endpoint وبهوک روی بک‌اند ایران — نه فقط دامنه.)

بعد از دیپلوی این نسخه‌ی relay، وبهوک تلگرام را به‌جای آدرس مستقیم بک‌اند، به آدرس relay ست
کنید:
```bash
curl -s "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d url="https://relay.nivoai.site/telegram-webhook" \
  -d secret_token="<همان secret_token قبلی/TELEGRAM_WEBHOOK_SECRET بک‌اند>"
```
بدون ست‌کردن `TELEGRAM_WEBHOOK_TARGET_URL`، مسیر `/telegram-webhook` روی این relay با ۴۰۴ رد
می‌شود و بقیه‌ی relay دست‌نخورده می‌ماند.

## بات دوم — مدیریت پنل فروشنده (docs/PRD-seller-telegram-management-bot.md)

توکن/وبهوک کاملاً جدا از بات بالا، ولی همان مشکل فیلترینگ ایران را دارد. **outbound نیازی به
تنظیم جدا ندارد** — همان route `/telegram` بالا کافی است چون relay فقط prefix را کنار می‌گذارد
و توکن را دست‌نخورده به `TELEGRAM_TARGET_BASE_URL` می‌زند؛ روی env بک‌اند فقط کافی است
`SELLER_BOT_API_BASE_URL=https://relay.nivoai.site/telegram` و
`SELLER_BOT_RELAY_SECRET=<همان RELAY_SHARED_SECRET>` ست شود.

**inbound** مسیر جدا می‌خواهد (`/seller-bot-webhook`، چون target یک endpoint متفاوت روی بک‌اند
است). روی سرور relay:
```
SELLER_BOT_WEBHOOK_TARGET_URL=https://api.nivoai.ir/api/v1/v2/seller-bot/webhook
```

بعد از دیپلوی این نسخه‌ی relay و دیپلوی بک‌اند با `SELLER_BOT_WEBHOOK_SECRET` ست‌شده، وبهوک
بات دوم را ثبت کنید:
```bash
curl -s "https://api.telegram.org/bot<SELLER_BOT_TOKEN>/setWebhook" \
  -d url="https://relay.nivoai.site/seller-bot-webhook" \
  -d secret_token="<همان SELLER_BOT_WEBHOOK_SECRET بک‌اند>"
```
بدون ست‌کردن `SELLER_BOT_WEBHOOK_TARGET_URL`، مسیر `/seller-bot-webhook` روی این relay با ۴۰۴
رد می‌شود و بقیه‌ی relay (شامل بات اول) دست‌نخورده می‌ماند.
