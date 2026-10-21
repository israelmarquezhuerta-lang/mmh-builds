import { onRequestGet as legacyGet, onRequestPost as legacyPost } from '../_lib/whatsapp-legacy.js';
import { enabled, json, readBody, verifySignature, saveInbound, applyStatus, respondToInbound } from '../_lib/whatsapp.js';

export async function onRequestGet(context) {
  // Never run a billable diagnostic from an unauthenticated public URL.
  if (new URL(context.request.url).searchParams.has('test')) return json(403, { error: 'Diagnóstico público deshabilitado.' });
  return legacyGet(context);
}
export async function onRequestPost(context) {
  const { request, env } = context;
  if (!enabled(env)) return legacyPost(context);
  if (!env.DB || !env.WHATSAPP_APP_SECRET || !env.WHATSAPP_PHONE_ID || !env.WHATSAPP_TOKEN || !env.GEMINI_API_KEY) return json(503, { error: 'Configuración incompleta.' });
  try {
    const raw = await readBody(request);
    if (!await verifySignature(raw, request.headers.get('x-hub-signature-256'), env.WHATSAPP_APP_SECRET)) return json(401, { error: 'Firma no válida.' });
    let body; try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { return json(400, { error: 'JSON no válido.' }); }
    if (body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return json(400, { error: 'Evento no válido.' });
    const pending = [];
    // Persist the entire event before starting any slow external requests.
    for (const entry of body.entry) for (const change of entry.changes || []) {
      const value = change.value;
      if (change.field !== 'messages' || String(value?.metadata?.phone_number_id) !== String(env.WHATSAPP_PHONE_ID)) continue;
      for (const status of value.statuses || []) await applyStatus(env.DB, status);
      for (const message of value.messages || []) {
        const name = value.contacts?.find(c => c.wa_id === message.from)?.profile?.name || '';
        const id = await saveInbound(env.DB, String(env.WHATSAPP_PHONE_ID), message, name);
        pending.push([id, message.id]);
      }
    }
    // Await completion: never acknowledge before the durable work finishes.
    // On transient failure Meta retries; unique IDs suppress already completed work.
    for (const [id, metaId] of pending) await respondToInbound(env, env.DB, id, metaId);
    return json(200, { received: true });
  } catch (error) {
    console.error('WhatsApp webhook failed', error.status || 503); // No payloads or credentials.
    return json(error.status || 503, { error: 'No se pudo procesar el evento.' });
  }
}
