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
