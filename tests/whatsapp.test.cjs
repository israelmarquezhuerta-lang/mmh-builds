const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
let wa, hook, router;
const base = 'https://mmh-builds.pages.dev';
const phone = '1234567890';
const customer = '525500000001';
const originalFetch = global.fetch;
test.before(async () => {
  wa = await import('../functions/_lib/whatsapp.js'); hook = await import('../functions/api/whatsapp.js'); router = await import('../functions/api/[[path]].js');
});
test.afterEach(() => { global.fetch = originalFetch; });
function database() {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys=ON;');
  for (const file of fs.readdirSync(path.join(__dirname, '../migrations')).sort()) sqlite.exec(fs.readFileSync(path.join(__dirname, '../migrations', file), 'utf8'));
  const db = { sqlite, prepare(sql) {
    const params = []; const prepared = {
      bind(...values) { params.push(...values); return prepared; },
      async first() { return sqlite.prepare(sql).get(...params) || null; },
      async all() { return { results: sqlite.prepare(sql).all(...params) }; },
      async run() { const r = sqlite.prepare(sql).run(...params); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }
    }; return prepared;
  }, async batch(statements) {
    sqlite.exec('BEGIN'); try { const results = []; for (const s of statements) results.push(await s.run()); sqlite.exec('COMMIT'); return results; } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  } }; return db;
}
function env(DB) { return { DB, WHATSAPP_INBOX_ENABLED: 'true', WHATSAPP_PHONE_ID: phone, WHATSAPP_TOKEN: 'dummy-whatsapp-token', WHATSAPP_APP_SECRET: 'test-app-secret', GEMINI_API_KEY: 'dummy-gemini-key', MMH_ADMIN_EMAILS: 'owner@example.test' }; }
const message = (id = 'wamid.in.1', text = 'Quiero una PC gamer') => ({ id, from: customer, type: 'text', text: { body: text }, timestamp: String(Math.floor(Date.now() / 1000)) });
const payload = messages => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: phone }, contacts: [{ wa_id: customer, profile: { name: 'Cliente <script>' } }], messages } }] }] });
async function signature(raw, secret = 'test-app-secret') { const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return 'sha256=' + Buffer.from(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(raw))).toString('hex'); }
async function webhook(DB, data, custom = {}) { const raw = JSON.stringify(data); return hook.onRequestPost({ request: new Request(base + '/api/whatsapp', { method: 'POST', headers: { 'x-hub-signature-256': await signature(raw) }, body: raw }), env: { ...env(DB), ...custom } }); }
async function admin(DB, id, action, input) { return wa.handleAdmin(new Request(base + '/api/local/admin/whatsapp/' + encodeURIComponent(id) + '/' + action, { method: 'POST' }), env(DB), DB, '/api/local/admin/whatsapp/' + encodeURIComponent(id) + '/' + action, 'owner@example.test', async () => input); }
function stubFetch() { const calls = []; global.fetch = async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return new Response(JSON.stringify(url.includes('googleapis') ? { candidates: [{ content: { parts: [{ text: 'Hola, ¿cuál es tu presupuesto?' }] } }] } : { messages: [{ id: 'wamid.out.' + calls.length }] }), { status: 200 }); }; return calls; }
async function ownerSession(DB, email = 'owner@example.test') {
  DB.sqlite.prepare('INSERT INTO customers VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(email, 'Owner', '555', 'Test', '00', '00', new Date().toISOString(), null);
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('session-test'))).toString('hex');
  DB.sqlite.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash, email, Date.now() + 60_000);
}
test('signature verifies exact raw bytes and rejects missing or tampered events before any writes', async () => {
  const DB = database(); const raw = JSON.stringify(payload([message()])); const sig = await signature(raw);
  assert.equal(await wa.verifySignature(new TextEncoder().encode(raw), sig, 'test-app-secret'), true);
  assert.equal(await wa.verifySignature(new TextEncoder().encode(raw + ' '), sig, 'test-app-secret'), false);
  const r = await hook.onRequestPost({ request: new Request(base + '/api/whatsapp', { method: 'POST', body: raw }), env: env(DB) });
  assert.equal(r.status, 401); assert.equal(DB.sqlite.prepare('SELECT count(*) n FROM wa_messages').get().n, 0);
});
test('activation fails closed without app secret and public AI diagnostic is disabled', async () => {
  assert.equal((await webhook(database(), payload([message()]), { WHATSAPP_APP_SECRET: '' })).status, 503);
  assert.equal((await hook.onRequestGet({ request: new Request(base + '/api/whatsapp?test=1'), env: {} })).status, 403);
});
test('inbound, Gemini and accepted outgoing are persisted; duplicate webhook does not reply or increment unread twice', async () => {
  const DB = database(); const calls = stubFetch(); const body = payload([message()]);
  assert.equal((await webhook(DB, body)).status, 200); assert.equal((await webhook(DB, body)).status, 200);
  assert.equal(calls.length, 2); assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM wa_messages').get().n, 2);
  const c = DB.sqlite.prepare('SELECT * FROM wa_conversations').get(); assert.equal(c.unread, 1); assert.equal(c.interest, 'pc');
  const out = DB.sqlite.prepare("SELECT * FROM wa_messages WHERE direction='out'").get(); assert.equal(out.status, 'accepted'); assert.ok(out.meta_id);
});
test('processes all entries and messages; multimedia is stored for intervention without inventing its content', async () => {
  const DB = database(); stubFetch(); const body = payload([message(), message('wamid.in.2', 'Necesito una aplicación')]);
  const second = payload([{ ...message('wamid.audio'), type: 'audio', audio: { id: 'private-media' } }]).entry[0]; body.entry.push(second);
  assert.equal((await webhook(DB, body)).status, 200);
  assert.equal(DB.sqlite.prepare("SELECT COUNT(*) n FROM wa_messages WHERE direction='in'").get().n, 3);
  assert.equal(DB.sqlite.prepare('SELECT needs_attention FROM wa_conversations').get().needs_attention, 1);
  assert.equal(DB.sqlite.prepare("SELECT body FROM wa_messages WHERE meta_id='wamid.audio'").get().body, '[Mensaje audio]');
});
test('unrelated phone-number events are ignored', async () => {
  const DB = database(); const data = payload([message()]); data.entry[0].changes[0].value.metadata.phone_number_id = '999';
  assert.equal((await webhook(DB, data)).status, 200); assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM wa_messages').get().n, 0);
});
test('manual mode only pauses its own conversation and inbound messages keep being recorded', async () => {
  const DB = database(); const id = await wa.saveInbound(DB, phone, message());
  await admin(DB, id, 'mode', { mode: 'manual' }); const calls = stubFetch(); await webhook(DB, payload([message('wamid.in.2')]));
  assert.equal(calls.length, 0); assert.equal(DB.sqlite.prepare("SELECT COUNT(*) n FROM wa_messages WHERE direction='in'").get().n, 2);
  await webhook(DB, payload([{ ...message('wamid.in.other'), from: '525500000002' }])); assert.equal(calls.length, 2);
  await admin(DB, id, 'mode', { mode: 'bot' }); await webhook(DB, payload([message('wamid.in.3')])); assert.equal(calls.length, 4);
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM wa_admin_events').get().n, 2);
});
test('Gemini context includes prior conversation and supports web/app intent', async () => {
  const DB = database(); const calls = stubFetch(); await webhook(DB, payload([message('wamid.1', 'Necesito una página web')]));
  await webhook(DB, payload([message('wamid.2', 'Para mi negocio de llantas')]));
  const secondPrompt = calls.filter(c => c.url.includes('googleapis'))[1].body;
  assert.equal(secondPrompt.contents.length, 3); assert.match(secondPrompt.contents[0].parts[0].text, /página web/);
  assert.equal(DB.sqlite.prepare('SELECT interest FROM wa_conversations').get().interest, 'web'); assert.equal(wa.interestOf('Quiero una aplicación'), 'app');
});
test('in-flight Gemini prevents taking the conversation until sending completes', async () => {
  const DB = database(); let unblock, entered; const started = new Promise(r => { entered = r; });
  global.fetch = async url => { if (url.includes('googleapis')) { entered(); await new Promise(r => { unblock = r; }); return Response.json({ candidates: [{ content: { parts: [{ text: 'Respuesta' }] } }] }); } return Response.json({ messages: [{ id: 'wamid.sent' }] }); };
  const processing = webhook(DB, payload([message()])); await started;
  const id = wa.conversationId(phone, customer);
  await assert.rejects(admin(DB, id, 'mode', { mode: 'manual' }), e => e.status === 409);
  unblock(); assert.equal((await processing).status, 200);
  assert.equal((await admin(DB, id, 'mode', { mode: 'manual' })).status, 200);
});
test('manual send requires ownership mode, checks service window and deduplicates client retries', async () => {
  const DB = database(); const id = await wa.saveInbound(DB, phone, message()); const calls = stubFetch(); const input = { text: 'Hola, te atiende Israel', key: crypto.randomUUID() };
  await assert.rejects(admin(DB, id, 'messages', input), e => e.status === 409);
  await admin(DB, id, 'mode', { mode: 'manual' });
  assert.equal((await admin(DB, id, 'messages', input)).status, 200); assert.equal((await admin(DB, id, 'messages', input)).status, 200); assert.equal(calls.length, 1);
  DB.sqlite.prepare('UPDATE wa_conversations SET last_inbound_at=1 WHERE id=?').run(id);
  await assert.rejects(admin(DB, id, 'messages', { ...input, key: crypto.randomUUID() }), e => e.status === 409); assert.equal(calls.length, 1);
});
test('uncertain outbound is not retried on duplicate webhook and surfaces attention', async () => {
  const DB = database(); let sends = 0;
  global.fetch = async url => { if (url.includes('googleapis')) return Response.json({ candidates: [{ content: { parts: [{ text: 'Hola' }] } }] }); sends++; throw new Error('network timeout'); };
  await webhook(DB, payload([message()])); await webhook(DB, payload([message()]));
  assert.equal(sends, 1); assert.equal(DB.sqlite.prepare("SELECT status FROM wa_messages WHERE direction='out'").get().status, 'unknown'); assert.equal(DB.sqlite.prepare('SELECT needs_attention FROM wa_conversations').get().needs_attention, 1);
});
test('Meta rejection is stored with safe code and no access token in response', async () => {
  const DB = database(); const id = await wa.saveInbound(DB, phone, message()); await admin(DB, id, 'mode', { mode: 'manual' });
  global.fetch = async () => Response.json({ error: { code: 131047, message: 'sensitive upstream text' } }, { status: 400 });
  const response = await admin(DB, id, 'messages', { text: 'Hola', key: crypto.randomUUID() }); const data = await response.json();
  assert.equal(data.message.status, 'failed'); assert.equal(data.message.error_code, '131047'); assert.ok(!JSON.stringify(data).includes('sensitive'));
});
test('status events are deduplicated and read cannot regress to delivered or sent', async () => {
  const DB = database(); stubFetch(); await webhook(DB, payload([message()])); const out = DB.sqlite.prepare("SELECT meta_id FROM wa_messages WHERE direction='out'").get().meta_id;
  const now = Math.floor(Date.now() / 1000); await wa.applyStatus(DB, { id: out, status: 'read', timestamp: now });
  await wa.applyStatus(DB, { id: out, status: 'read', timestamp: now }); await wa.applyStatus(DB, { id: out, status: 'sent', timestamp: now + 1 });
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM wa_delivery_events').get().n, 2); assert.equal(DB.sqlite.prepare('SELECT status FROM wa_messages WHERE meta_id=?').get(out).status, 'read');
});
test('status arriving before send response is reconciled after Meta ID is saved', async () => {
  const DB = database(); const id = await wa.saveInbound(DB, phone, message()); await admin(DB, id, 'mode', { mode: 'manual' });
  global.fetch = async () => { await wa.applyStatus(DB, { id: 'wamid.early', status: 'delivered', timestamp: Math.floor(Date.now() / 1000) }); return Response.json({ messages: [{ id: 'wamid.early' }] }); };
  const response = await admin(DB, id, 'messages', { text: 'Hola', key: crypto.randomUUID() }); assert.equal((await response.json()).message.status, 'delivered');
});
test('read marker does not swallow messages arriving after the displayed page', async () => {
  const DB = database(); const id = await wa.saveInbound(DB, phone, message()); const first = DB.sqlite.prepare('SELECT id FROM wa_messages').get().id;
  await wa.saveInbound(DB, phone, message('wamid.new')); await admin(DB, id, 'read', { through: first }); assert.equal(DB.sqlite.prepare('SELECT unread FROM wa_conversations').get().unread, 1);
});
test('private endpoints enforce real sessions, admin allowlist, same-origin writes and no-store', async () => {
  const DB = database(); const id = await wa.saveInbound(DB, phone, message()); await ownerSession(DB);
  const call = (suffix, options = {}, extra = {}) => router.onRequest({ request: new Request(base + '/api/local/admin/whatsapp' + suffix, options), env: { ...env(DB), ...extra } });
  assert.equal((await call('')).status, 403);
  assert.equal((await call('', { headers: { Cookie: 'mmh_local_session=session-test' } }, { MMH_ADMIN_EMAILS: 'someone@example.test' })).status, 403);
  const result = await call('', { headers: { Cookie: 'mmh_local_session=session-test' } }); assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store'); const data = await result.json(); assert.equal(data.conversations.length, 1); assert.ok(!('lock_token' in data.conversations[0]));
  assert.equal((await call('/' + encodeURIComponent(id) + '/mode', { method: 'POST', headers: { Cookie: 'mmh_local_session=session-test', Origin: 'https://attacker.example' }, body: '{}' })).status, 403);
  const messages = await call('/' + encodeURIComponent(id) + '/messages', { headers: { Cookie: 'mmh_local_session=session-test' } }); assert.equal(messages.status, 200);
});
test('additive migration preserves customer/order schema and is safely repeatable', () => {
  const DB = database(); DB.sqlite.exec(fs.readFileSync(path.join(__dirname, '../migrations/0005_whatsapp_messages.sql'), 'utf8'));
  assert.ok(DB.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='orders'").get()); assert.ok(DB.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='sessions'").get());
});
test('resuming Gemini clears intervention and never answers old pending messages', async () => {
  const DB = database(); const id = await wa.saveInbound(DB, phone, message('wamid.handoff', 'Quiero hablar con una persona'));
  await admin(DB, id, 'mode', { mode: 'manual' }); await admin(DB, id, 'mode', { mode: 'bot' });
  assert.equal(DB.sqlite.prepare('SELECT needs_attention FROM wa_conversations').get().needs_attention, 0);
  assert.equal(DB.sqlite.prepare('SELECT bot_status FROM wa_messages').get().bot_status, 'manual');
  const calls = stubFetch(); await webhook(DB, payload([message('wamid.next')])); assert.equal(calls.length, 2);
});
test('terminated worker send is exposed as uncertain and acknowledgment remains resolved', async () => {
  const DB = database(); const id = await wa.saveInbound(DB, phone, message());
  DB.sqlite.prepare("INSERT INTO wa_messages (conversation_id, direction, sender, body, created_at, status, request_key) VALUES (?, 'out', 'admin', 'Hola', ?, 'sending', 'interrupted-key')").run(id, Date.now() - 100_000);
  await admin(DB, id, 'mode', { mode: 'manual' }); assert.equal(DB.sqlite.prepare("SELECT status FROM wa_messages WHERE direction='out'").get().status, 'unknown');
  await admin(DB, id, 'resolve', {}); await admin(DB, id, 'read', { through: 1 }); assert.equal(DB.sqlite.prepare('SELECT needs_attention FROM wa_conversations').get().needs_attention, 0);
});
test('feature flag off preserves legacy bot without using the new tables', async () => {
  const calls = stubFetch();
  const response = await hook.onRequestPost({ request: new Request(base + '/api/whatsapp', { method: 'POST', body: JSON.stringify(payload([message()])) }), env: { GEMINI_API_KEY: 'dummy', WHATSAPP_PHONE_ID: phone, WHATSAPP_TOKEN: 'dummy' } });
  assert.equal(response.status, 200); assert.equal(calls.length, 2); assert.match(calls[0].url, /gemini-3.8-flash/);
});
test('oversized webhook bodies are rejected without a database write', async () => {
  const DB = database(); const response = await hook.onRequestPost({ request: new Request(base + '/api/whatsapp', { method: 'POST', body: 'x'.repeat(270000) }), env: env(DB) });
  assert.equal(response.status, 413); assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM wa_messages').get().n, 0);
});
test('active conversation lock returns retryable failure without losing inbound persistence', async () => {
  const DB = database(); const id = await wa.saveInbound(DB, phone, message()); const token = await wa.acquire(DB, id, 'bot'); const calls = stubFetch();
  assert.equal((await webhook(DB, payload([message()]))).status, 503); assert.equal(calls.length, 0);
  await wa.release(DB, id, token); assert.equal((await webhook(DB, payload([message()]))).status, 200); assert.equal(calls.length, 2);
});
