import chatConfig from '../../chat-config.js';

export const WINDOW_MS = 24 * 60 * 60 * 1000;
const LOCK_MS = 90_000;
export const enabled = env => env.WHATSAPP_INBOX_ENABLED === 'true';
export const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export function json(status, value) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
export async function verifySignature(raw, signature, secret) {
  if (!secret || !/^sha256=[a-f0-9]{64}$/.test(signature || '')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const bytes = Uint8Array.from(signature.slice(7).match(/../g), hex => parseInt(hex, 16));
  return crypto.subtle.verify('HMAC', key, bytes, raw);
}
export async function readBody(request, max = 256 * 1024) {
  if (Number(request.headers.get('content-length') || 0) > max) throw fail('Solicitud demasiado grande.', 413);
  const reader = request.body?.getReader();
  if (!reader) throw fail('Solicitud vacía.');
  const chunks = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); throw fail('Solicitud demasiado grande.', 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}
export function interestOf(text) {
  const t = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/\b(app|apps|aplicacion|aplicaciones)\b/.test(t)) return 'app';
  if (/\b(web|pagina|paginas|sitio|ecommerce)\b/.test(t)) return 'web';
  if (/\b(pc|computadora|computadoras|gaming|gamer|laptop|ensamble|ryzen|rtx)\b/.test(t)) return 'pc';
  return 'other';
}
const handoff = text => /\b(humano|persona|asesor|reclamo|queja|urgente|problema|pago|transferencia)\b/i.test(text);
export function conversationId(phoneId, waId) { return `${phoneId}:${waId}`; }
export async function getConversation(db, id) {
  const row = await db.prepare('SELECT * FROM wa_conversations WHERE id = ?').bind(id).first();
  if (!row) throw fail('No se encontró la conversación.', 404);
  return row;
}
export function publicConversation(row) {
  const { lock_token, lock_until, ...safe } = row;
  return { ...safe, busy: lock_until > Date.now(), window_expires_at: row.last_inbound_at + WINDOW_MS };
}
export async function acquire(db, id, mode) {
  const token = crypto.randomUUID(); const now = Date.now();
  const result = await db.prepare('UPDATE wa_conversations SET lock_token = ?, lock_until = ? WHERE id = ? AND mode = ? AND lock_until <= ?')
    .bind(token, now + LOCK_MS, id, mode, now).run();
  return result.meta.changes ? token : null;
}
export async function release(db, id, token) {
  await db.prepare('UPDATE wa_conversations SET lock_token = NULL, lock_until = 0 WHERE id = ? AND lock_token = ?').bind(id, token).run();
}
export async function saveInbound(db, phoneId, message, name = '') {
  if (!/^\d{5,25}$/.test(message.from || '') || !message.id || typeof message.id !== 'string' || message.id.length > 250) throw fail('Evento de mensaje inválido.');
  const id = conversationId(phoneId, message.from);
  const timestamp = Number(message.timestamp) * 1000;
  if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > Date.now() + 300_000) throw fail('Fecha de mensaje inválida.');
  const text = message.type === 'text' ? String(message.text?.body || '').slice(0, 16_000) : `[Mensaje ${String(message.type || 'desconocido').slice(0, 30)}]${message.image?.caption ? ' ' + String(message.image.caption).slice(0, 2000) : ''}`;
  const interest = interestOf(text); const attention = handoff(text) || message.type !== 'text' ? 1 : 0;
  // Update counters only once, in the same transaction as insertion of the unique Meta ID.
  await db.batch([
    db.prepare(`INSERT INTO wa_conversations (id, phone_id, wa_id, name, interest, needs_attention, unread, last_inbound_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = CASE WHEN excluded.name != '' THEN excluded.name ELSE wa_conversations.name END,
      interest = CASE WHEN excluded.interest != 'other' THEN excluded.interest ELSE wa_conversations.interest END,
      needs_attention = MAX(wa_conversations.needs_attention, excluded.needs_attention), unread = wa_conversations.unread + 1,
      last_inbound_at = MAX(wa_conversations.last_inbound_at, excluded.last_inbound_at), updated_at = MAX(wa_conversations.updated_at, excluded.updated_at)
      WHERE NOT EXISTS (SELECT 1 FROM wa_messages WHERE meta_id = ?)`)
      .bind(id, phoneId, message.from, String(name).slice(0, 100), interest, attention, timestamp, timestamp, message.id),
    db.prepare(`INSERT OR IGNORE INTO wa_messages (conversation_id, meta_id, direction, sender, kind, body, created_at, status, bot_status)
      VALUES (?, ?, 'in', 'customer', ?, ?, ?, 'received', ?)`)
      .bind(id, message.id, String(message.type || 'unknown').slice(0, 30), text, timestamp, message.type === 'text' ? 'pending' : 'manual')
  ]);
  return id;
}
export async function applyStatus(db, status) {
  if (!status.id || !['sent','delivered','read','failed'].includes(status.status)) return;
  const at = Number(status.timestamp) * 1000; if (!Number.isFinite(at) || at <= 0) return;
  const code = status.errors?.[0]?.code; const error = code == null ? null : String(code).slice(0, 40);
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO wa_delivery_events (meta_id, status, event_at, error_code) VALUES (?, ?, ?, ?)').bind(status.id, status.status, at, error),
    db.prepare(`UPDATE wa_messages SET status = ?, status_at = ?, error_code = ? WHERE meta_id = ? AND direction = 'out'
      AND status_at <= ? AND (status NOT IN ('delivered','read') OR ? = 'read')`)
      .bind(status.status, at, error, status.id, at, status.status),
    db.prepare(`UPDATE wa_conversations SET needs_attention = 1 WHERE ? = 'failed' AND id IN (SELECT conversation_id FROM wa_messages WHERE meta_id = ?)`)
      .bind(status.status, status.id)
  ]);
}
async function gemini(env, db, id, through) {
  const history = await db.prepare("SELECT direction, body FROM wa_messages WHERE conversation_id = ? AND id <= ? AND kind = 'text' AND (direction = 'in' OR status IN ('accepted','sent','delivered','read')) ORDER BY id DESC LIMIT 20").bind(id, through).all();
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.WHATSAPP_GEMINI_MODEL || 'gemini-3.8-flash')}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: chatConfig.SYSTEM_INSTRUCTION + '\nCanal: WhatsApp. Responde brevemente. No pidas crear cuenta. No afirmes haber confirmado un pago ni una intervención humana.' }] }, contents: (history.results || []).reverse().map(m => ({ role: m.direction === 'in' ? 'user' : 'model', parts: [{ text: m.body.slice(0, 4000) }] })), generationConfig: { maxOutputTokens: 500 } }),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw fail('Gemini no disponible.', 502);
  const data = await response.json(); const text = data.candidates?.[0]?.content?.parts?.filter(p => !p.thought).map(p => p.text || '').join('').trim();
  if (!text) throw fail('Gemini no devolvió texto.', 502);
  return text.slice(0, 4096);
}
export async function sendStored(env, db, conversation, { text, sender, key, admin = null }) {
  // Persist intent before contacting Meta. An uncertain response is never resent automatically.
  const result = await db.prepare(`INSERT OR IGNORE INTO wa_messages (conversation_id, direction, sender, body, created_at, status, request_key, admin_email)
    VALUES (?, 'out', ?, ?, ?, 'sending', ?, ?)`).bind(conversation.id, sender, text, Date.now(), key, admin).run();
  if (!result.meta.changes) return db.prepare('SELECT id, status, error_code FROM wa_messages WHERE request_key = ?').bind(key).first();
  let status = 'unknown'; let metaId = null; let code = null;
  try {
    const response = await fetch(`https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_ID}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: conversation.wa_id.startsWith('521') && conversation.wa_id.length === 13 ? '52' + conversation.wa_id.slice(3) : conversation.wa_id, type: 'text', text: { body: text } }),
      signal: AbortSignal.timeout(15_000)
    });
    // A timeout, 5xx or malformed success may mean Meta already accepted the message.
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.messages?.[0]?.id) { status = 'accepted'; metaId = data.messages[0].id; }
    else { status = response.status >= 400 && response.status < 500 ? 'failed' : 'unknown'; code = data.error?.code == null ? `http_${response.status}` : String(data.error.code).slice(0, 40); }
  } catch { code = 'network_uncertain'; }
  await db.batch([
    db.prepare('UPDATE wa_messages SET status = ?, meta_id = ?, error_code = ? WHERE request_key = ?').bind(status, metaId, code, key),
    db.prepare('UPDATE wa_conversations SET updated_at = ?, needs_attention = MAX(needs_attention, ?) WHERE id = ?').bind(Date.now(), status === 'accepted' ? 0 : 1, conversation.id)
  ]);
  if (metaId) {
    const events = await db.prepare('SELECT meta_id AS id, status, event_at AS timestamp_ms, error_code FROM wa_delivery_events WHERE meta_id = ? ORDER BY event_at ASC').bind(metaId).all();
    for (const e of events.results || []) await applyStatus(db, { id: e.id, status: e.status, timestamp: e.timestamp_ms / 1000, errors: e.error_code ? [{ code: e.error_code }] : [] });
  }
  return db.prepare('SELECT id, status, error_code FROM wa_messages WHERE request_key = ?').bind(key).first();
}
export async function respondToInbound(env, db, id, metaId) {
  const input = await db.prepare('SELECT * FROM wa_messages WHERE meta_id = ?').bind(metaId).first();
  if (!input || input.bot_status !== 'pending') return;
  let conversation = await getConversation(db, id);
  if (conversation.mode === 'manual' || conversation.needs_attention || conversation.last_inbound_at + WINDOW_MS <= Date.now()) {
    await db.prepare("UPDATE wa_messages SET bot_status = 'manual' WHERE meta_id = ?").bind(metaId).run(); return;
  }
  const token = await acquire(db, id, 'bot');
  if (!token) throw fail('Conversación ocupada; reintentar evento.', 503);
  try {
    const current = await db.prepare('SELECT bot_status FROM wa_messages WHERE meta_id = ?').bind(metaId).first();
    if (current.bot_status !== 'pending') return;
    const existing = await db.prepare('SELECT status FROM wa_messages WHERE request_key = ?').bind(`bot:${metaId}`).first();
    if (existing && ['sending', 'unknown', 'failed'].includes(existing.status)) {
      await db.batch([
        db.prepare("UPDATE wa_messages SET status = 'unknown', error_code = 'interrupted' WHERE request_key = ? AND status = 'sending'").bind(`bot:${metaId}`),
        db.prepare('UPDATE wa_conversations SET needs_attention = 1 WHERE id = ?').bind(id)
      ]);
    }
    if (!existing) {
      let reply;
      try { reply = await gemini(env, db, id, input.id); }
      catch {
        await db.prepare('UPDATE wa_conversations SET needs_attention = 1 WHERE id = ?').bind(id).run();
        reply = 'Gracias por comunicarte con MMH Builds. En este momento el asistente no está disponible; tu mensaje quedó registrado para revisión del equipo.';
      }
      conversation = await getConversation(db, id);
      if (conversation.lock_token !== token || conversation.lock_until <= Date.now() || conversation.mode !== 'bot') throw fail('Atención en curso.', 503);
      await sendStored(env, db, conversation, { text: reply, sender: 'gemini', key: `bot:${metaId}` });
    }
    await db.prepare("UPDATE wa_messages SET bot_status = 'done' WHERE meta_id = ?").bind(metaId).run();
  } finally { await release(db, id, token); }
}

export async function handleAdmin(request, env, db, pathname, adminEmail, readJson) {
  if (!enabled(env)) return json(503, { error: 'El Centro de Mensajes todavía no está activado.' });
  if (!env.WHATSAPP_PHONE_ID) throw fail('Falta configurar el número empresarial en el servidor.', 503);
  // Recover persisted intents left behind by a terminated worker; never resend them.
  await db.batch([
    db.prepare("UPDATE wa_conversations SET needs_attention = 1 WHERE id IN (SELECT conversation_id FROM wa_messages WHERE status = 'sending' AND created_at < ?)").bind(Date.now() - LOCK_MS),
    db.prepare("UPDATE wa_messages SET status = 'unknown', error_code = 'interrupted' WHERE status = 'sending' AND created_at < ?").bind(Date.now() - LOCK_MS)
  ]);
  const root = '/api/local/admin/whatsapp';
  const url = new URL(request.url);
  if (pathname === root && request.method === 'GET') {
    const interest = url.searchParams.get('interest') || ''; const attention = url.searchParams.get('attention') === '1';
    const page = Math.max(0, Math.min(100000, Number.parseInt(url.searchParams.get('page') || '0', 10) || 0));
    const rows = await db.prepare(`SELECT * FROM wa_conversations WHERE phone_id = ? AND (? = '' OR interest = ?) AND (? = 0 OR needs_attention = 1 OR mode = 'manual') ORDER BY updated_at DESC, id LIMIT 51 OFFSET ?`)
      .bind(env.WHATSAPP_PHONE_ID, interest, interest, Number(attention), page * 50).all();
    const counts = await db.prepare('SELECT COUNT(*) AS attention, COALESCE(MAX(last_inbound_at), 0) AS revision FROM wa_conversations WHERE phone_id = ? AND (needs_attention = 1 OR mode = ? OR unread > 0)').bind(env.WHATSAPP_PHONE_ID, 'manual').first();
    return json(200, { conversations: (rows.results || []).slice(0, 50).map(publicConversation), more: rows.results.length > 50, page, attention: counts.attention, revision: counts.revision });
  }
  const match = pathname.slice(root.length).match(/^\/([^/]+)(?:\/(messages|mode|read|resolve))?$/);
  if (!match) return json(404, { error: 'Operación no encontrada.' });
  let id; try { id = decodeURIComponent(match[1]); } catch { throw fail('Identificador inválido.'); }
  const conversation = await getConversation(db, id);
  if (conversation.phone_id !== env.WHATSAPP_PHONE_ID) throw fail('Conversación no encontrada.', 404);
  const action = match[2];
  if (action === 'messages' && request.method === 'GET') {
    const before = Number(url.searchParams.get('before') || Number.MAX_SAFE_INTEGER);
    const result = await db.prepare(`SELECT id, meta_id, direction, sender, kind, body, created_at, status, error_code FROM wa_messages WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT 101`).bind(id, before).all();
    return json(200, { conversation: publicConversation(conversation), messages: result.results.slice(0, 100).reverse(), more: result.results.length > 100 });
  }
  if (request.method !== 'POST') return json(405, { error: 'Método no permitido.' });
  const input = await readJson(request);
  if (action === 'read') {
    const through = Number(input.through);
    if (!Number.isSafeInteger(through) || through < 1) throw fail('Último mensaje no válido.');
    await db.prepare("UPDATE wa_conversations SET unread = (SELECT COUNT(*) FROM wa_messages WHERE conversation_id = ? AND direction = 'in' AND id > ?) WHERE id = ?").bind(id, through, id).run();
    return json(200, { ok: true });
  }
  if (action === 'mode' || action === 'resolve') {
    if (action === 'mode' && !['bot','manual'].includes(input.mode)) throw fail('Modo no válido.');
    const token = await acquire(db, id, conversation.mode);
    if (!token) throw fail('Hay un envío en curso. Espera unos segundos y vuelve a intentarlo.', 409);
    try {
      const update = action === 'mode'
        ? db.prepare("UPDATE wa_conversations SET mode = ?, needs_attention = CASE WHEN ? = 'bot' THEN 0 ELSE needs_attention END, updated_at = ? WHERE id = ?").bind(input.mode, input.mode, Date.now(), id)
        : db.prepare('UPDATE wa_conversations SET needs_attention = 0, updated_at = ? WHERE id = ?').bind(Date.now(), id);
      await db.batch([
        update,
        db.prepare('INSERT INTO wa_admin_events (conversation_id, admin_email, action, created_at) VALUES (?, ?, ?, ?)').bind(id, adminEmail, action === 'mode' ? `mode:${input.mode}` : 'resolved', Date.now()),
        // Do not send delayed bot replies when the owner resumes the conversation.
        db.prepare("UPDATE wa_messages SET bot_status = 'manual' WHERE conversation_id = ? AND bot_status = 'pending'").bind(id)
      ]);
    } finally { await release(db, id, token); }
    return json(200, { ok: true });
  }
  if (action === 'messages') {
    const text = String(input.text || '').trim();
    if (!text || text.length > 4096 || !/^[a-f0-9-]{36}$/.test(input.key || '')) throw fail('Escribe un mensaje de hasta 4096 caracteres.');
    const key = `admin:${id}:${input.key}`;
    const previous = await db.prepare('SELECT id, status, error_code FROM wa_messages WHERE request_key = ?').bind(key).first();
    if (previous) return json(200, { message: previous });
    if (conversation.mode !== 'manual') throw fail('Primero toma la conversación para pausar a Gemini.', 409);
    if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_ID) throw fail('Envío no configurado.', 503);
    if (conversation.last_inbound_at + WINDOW_MS <= Date.now()) throw fail('La ventana de respuesta de 24 horas terminó. Espera un nuevo mensaje del cliente; el envío de plantillas no está habilitado en este panel.', 409);
    const token = await acquire(db, id, 'manual');
    if (!token) throw fail('Hay otro envío en curso. Espera unos segundos.', 409);
    try {
      const sent = await sendStored(env, db, conversation, { text, sender: 'admin', key, admin: adminEmail });
      return json(200, { message: sent });
    } finally { await release(db, id, token); }
  }
  return json(404, { error: 'Operación no encontrada.' });
}
