# Centro de Mensajes de WhatsApp

## Implementation and rollout boundary

This branch adds a real private inbox to the existing Cloudflare Pages/D1 application.
No live D1 queries, migrations, deployments, Meta webhook changes, token changes or real WhatsApp sends were performed during implementation. Tests use temporary SQLite databases and mocked upstream calls, never production customers.

`WHATSAPP_INBOX_ENABLED` is opt-in and defaults to disabled. When disabled, POST events use the previous bot implementation. A public billable `?test=1` endpoint is disabled in both modes. Keep the existing `WHATSAPP_PHONE_ID`, `WHATSAPP_TOKEN`, `WHATSAPP_VERIFY_TOKEN` and webhook URL unchanged.

## Files and architecture

- `functions/api/whatsapp.js`: raw-body signature verification, all entries/changes/messages, receiving and delivery callbacks.
- `functions/_lib/whatsapp.js`: persistence, Gemini context, delivery, conversation locking, admin operations.
- `functions/_lib/whatsapp-legacy.js`: previous POST behavior when the flag is off; no public AI test handler.
- `functions/api/[[path]].js`: existing administrator session and allowlist protect new endpoints.
- `migrations/0005_whatsapp_messages.sql`: additive tables; no modifications to customers, sessions or orders.
- `whatsapp-admin.js`, `storefront.css`, `index.html`: responsive admin-only inbox inside the existing application.
- `sw.js`: new application-shell version; API requests continue to bypass offline cache.
- `tests/whatsapp.test.cjs`: signed events, real SQLite migrations, duplicates, locking, sending failures, permissions and recovery.

## Data model

`wa_conversations`: canonical `(phone_id, wa_id)` key, profile name, inferred interest (`pc/web/app/other`), bot/manual mode, unread and intervention flags, last customer message and sending lock.

`wa_messages`: incoming and outgoing text, media-type placeholders, Meta ID, sender, delivery status, safe error code, idempotency key and administrator email on manual sends. Each Meta message ID is unique. Counters and inbound insert are transactional.

`wa_delivery_events`: idempotent delivery updates, including callbacks arriving before the send response is saved. No complete webhook payloads are retained.

`wa_admin_events`: who paused/resumed/resolved a conversation and when. Administrative permissions remain exclusively in `MMH_ADMIN_EMAILS`; phone numbers do not grant access. WhatsApp contacts are not automatically linked to website accounts based on unverified contact data.

History starts on activation. Older conversations are never fabricated or imported automatically.

## Administrator workflow

Sign in with an existing account whose email is in the server-side `MMH_ADMIN_EMAILS` allowlist. The private Centro de Mensajes section appears in the page. It works in desktop and Android browsers.

1. Filter conversations by PCs, websites, applications or intervention. Interest is a heuristic, not a confirmed order or sale.
2. Open a conversation. Reading marks only the messages actually returned by that request as read; newly arriving messages remain unread.
3. Choose **Atender y pausar Gemini**. If a send is already in progress, wait and retry: the server returns 409 instead of racing the bot.
4. Send a manual text response. The server checks manual mode, the most recent inbound timestamp and the 24-hour service window, and stores the intent before calling Meta.
5. Choose **Terminar y reactivar Gemini**. This clears the intervention flag and re-enables replies to new incoming messages. It never sends delayed replies to messages already received during manual attention.

Requests for a person, payment issues, multimedia, AI errors and failed/uncertain sends raise intervention. Gemini waits while intervention is flagged. The owner can mark reviewed or explicitly resume the bot.

## Delivery and failure semantics

- `accepted` means the API returned a WhatsApp message ID; it does not mean delivered.
- `sent`, `delivered`, `read` and `failed` come from signed status callbacks. Read status never regresses to sent/delivered.
- Definitive HTTP 4xx failures are saved as rejected. Network timeouts, 5xx responses or malformed successes are uncertain.
- Uncertain sends and interrupted `sending` intents are never automatically resent. They are shown for manual review. The same client request key returns the original outcome.
- Bot and owner share a 90-second per-conversation lock. External calls have 15-second timeouts. A takeover cannot succeed while the bot is sending. A bot callback busy with another request returns 503 so Meta can retry; persistence and unique IDs prevent duplicate completed sends.
- Incoming events are persisted before external generation begins. Webhook handling awaits work instead of acknowledging untracked background promises.
- If D1 is unavailable while the new mode is enabled, the webhook returns a retryable failure rather than sending without persistence. Do not toggle to legacy during an outage without reviewing possible duplicate deliveries and paused conversations.

## Notifications, privacy and deliberate limits

The page refreshes every 10 seconds and displays a review counter. Browser notifications are optional, requested only by pressing the activation button, and contain a generic alert without client names or message previews. They require the page to remain open and browser support. This version does not provide push notifications after the app/browser closes. Android may throttle background tabs.

Messages stay in browser memory only: no localStorage, IndexedDB, offline API cache or client-side credentials. Logout clears displayed customer data and drafts. All APIs require an authenticated allowlisted administrator, return `Cache-Control: no-store`, and reject cross-origin mutations. HTML is escaped before rendering messages and names.

Multimedia events are stored as type placeholders and routed for review; downloading, previewing or transcribing attachments is not included. Manual sends support plain text within the service window. Outside that window the server blocks sending; approved-template selection is not implemented. No historical import, native APK, marketing automation or automatic payment verification is included.

Data retention is not automatically destructive. Configure an appropriate retention policy separately before large-scale use; deleting customer history is not part of this rollout.

## Preflight: requires authenticated Cloudflare access

Read-only verification before activation:

1. Confirm the intended Cloudflare Pages project and deployed commit. The reviewed base commit was `946c6e66f269b0afaaedde91f97fa7c26480ccb4`.
2. Confirm the project uses D1 binding `DB` and that it points to the existing intended database. `wrangler.toml` declares `mmh-builds`; this declaration alone does not prove live connectivity.
3. In the D1 console, inspect `sqlite_master` and table columns without selecting customer rows:
   ```sql
   SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;
   PRAGMA table_info(customers);
   PRAGMA table_info(sessions);
   PRAGMA table_info(orders);
   SELECT 1 AS connection_ok;
   ```
4. Check migrations 0001–0004 against the actual schema. Deployment documentation may lag the repository. Never blindly replay ALTER TABLE migrations if they were applied manually.
5. Verify the existing server-side secret names are present without revealing their values. New mode requires `WHATSAPP_APP_SECRET` in addition to the existing access token, Phone Number ID and Gemini key. App Secret is the Meta app's secret; it is not the verification token.
6. Confirm the admin email is already configured in `MMH_ADMIN_EMAILS`. Do not grant all registered customers access.

## Isolated verification

Use a separate preview D1 database and test Meta app/number, or mocked HTTP upstreams. A preview must not inherit production D1 data or the production sending token. Do not point production webhooks at the preview.

Apply migrations to the isolated database, run `npm install --ignore-scripts --no-package-lock`, create the `work` directory required by the existing checkout test, then run `npm test` with Node 24+. Tests use Node's built-in SQLite module. No live token is required.

Verify in a real preview: administrator login, signed inbound event, a duplicated event, inbound media, accepted/failed delivery callbacks, manual takeover, reply and resume. Confirm a non-admin cannot read endpoints or see data, and test Android layout. Validate the existing website chat, checkout and OAuth as well.

## Authorized production activation only

1. Back up the intended D1 database and record the deployed revision.
2. Apply only the additive `0005_whatsapp_messages.sql` migration once to that verified database. Its CREATE statements are repeatable and do not drop existing tables.
3. Configure `WHATSAPP_APP_SECRET` as a server secret, retain existing credentials unchanged, and ensure the administrator allowlist is correct. Do not paste secret values into chat or GitHub.
4. Deploy the reviewed branch with `WHATSAPP_INBOX_ENABLED=false` first. The previous POST flow remains in use.
5. Activate `WHATSAPP_INBOX_ENABLED=true` only after schema/bindings/secrets are verified. Keep the webhook path and subscribed number unchanged. Retain the existing WhatsApp model by leaving `WHATSAPP_GEMINI_MODEL` unset.
6. Send one explicitly approved real test message from a controlled number. Check persistence, response ID and delivery callback, then take the conversation, send a manual response and resume. Check error counts without logging private message bodies.

Do not run these production actions just because the branch has passed local tests.

## Rollback

Do not drop the new tables. Before disabling the feature or reverting the webhook, finish any active sends and review all conversations in manual mode: the legacy bot does not understand per-conversation pauses and could resume responding. Preserve history. Review uncertain sends before retrying. Roll back the code/flag only after confirming these conditions; the existing webhook URL and credentials need not change.

## Official references

- Meta webhook verification: https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/
- Meta WhatsApp Cloud API collection: https://www.postman.com/meta/whatsapp-business-platform/collection/wlk6lh4/whatsapp-cloud-api
- WhatsApp Business Messaging Policy: https://business.whatsapp.com/policy

## Validation completed on this branch

- `npm test`: 40 passing tests, including 21 WhatsApp tests backed by temporary SQLite and mocked Meta/Gemini calls.
- `wrangler pages functions build --outdir work/pages-functions`: Worker compiled successfully.
- `scripts/verify-whatsapp-ui.cjs`: Chromium at desktop 1440×1000 and Android-size 390×844 viewports, using synthetic API fixtures. Manual send/resume, XSS escaping, no horizontal overflow, and logout data clearing passed. This is a browser viewport check, not a physical Android device test.
- `git diff --check`: clean.

For the optional browser check, install Playwright separately, create `work/`, and run `node scripts/verify-whatsapp-ui.cjs` from the repository root. `PLAYWRIGHT_MODULE_PATH` and `CHROMIUM_EXECUTABLE` can point to an existing installation. Screenshots are written under ignored `work/`, never published as customer history. No live Cloudflare or Meta acceptance test has been performed.
