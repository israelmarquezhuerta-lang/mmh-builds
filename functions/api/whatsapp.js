import { ensureWhatsAppInbox } from '../../whatsapp-inbox.mjs';

async function consultarGemini(userText, geminiKey) {
  if (!geminiKey) return null;

  const prompt = `Eres el asesor virtual experto de "MMH Builds", una tienda y taller especializado en ensamble de computadoras de alto rendimiento y venta de componentes (tarjetas RTX, procesadores Ryzen/Intel, etc.) en México.
Tu tono es experto, profesional, entusiasta y muy amable.
El cliente te escribió por WhatsApp: "${userText}".
Responde de forma clara, breve (estilo WhatsApp) y útil en español de México. Si te preguntan por un ensamble o cotización, pregunta qué uso le darán (gaming, render, oficina) y su presupuesto aproximado. Si te dan un folio (ejemplo MMH-...), diles con gusto que el equipo técnico revisará los componentes para confirmar disponibilidad.`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${geminiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });

    if (res.ok) {
      const data = await res.json();
      const parts = data.candidates?.[0]?.content?.parts || [];
      const textPart = parts.find(p => p.text && !p.thought) || parts[parts.length - 1];
      if (textPart && textPart.text) {
        return textPart.text;
      }
    }
  } catch (e) {
    console.error("Error en Gemini:", e);
  }
  return null;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

async function verifyMetaSignature(request, rawBody, secret) {
  // Fail closed: an unset app secret must never disable webhook verification.
  if (!secret) return false;
  const supplied = request.headers.get("x-hub-signature-256") || "";
  if (!supplied.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, rawBody));
  const expected = `sha256=${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}`;
  if (expected.length !== supplied.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  return difference === 0;
}

async function saveWhatsAppMessage(db, message) {
  const result = await db.prepare(`INSERT OR IGNORE INTO whatsapp_messages
    (message_id,phone,contact_name,direction,message_type,body,status,created_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .bind(message.id, message.phone, message.contactName || null, message.direction,
      message.type || "text", message.body, message.status || "received", message.createdAt)
    .run();
  return Boolean(result.meta?.changes);
}

function messageText(message) {
  if (message.type === "text") return String(message.text?.body || "").trim();
  if (message.type === "image") return String(message.image?.caption || "[Imagen recibida]").trim();
  if (message.type === "video") return String(message.video?.caption || "[Video recibido]").trim();
  if (message.type === "document") return String(message.document?.caption || `[Documento recibido${message.document?.filename ? `: ${message.document.filename}` : ""}]`).trim();
  if (message.type === "audio" || message.type === "voice") return "[Audio recibido]";
  if (message.type === "location") return "[Ubicación recibida]";
  if (message.type === "sticker") return "[Sticker recibido]";
  return `[Mensaje ${String(message.type || "no compatible").slice(0, 40)} recibido]`;
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);

  // Verificación Webhook Meta
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const VERIFY_TOKEN = context.env.WHATSAPP_VERIFY_TOKEN;

  if (VERIFY_TOKEN && mode === "subscribe" && token === VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

export async function onRequestPost(context) {
  try {
    const rawBody = await context.request.arrayBuffer();
    if (!await verifyMetaSignature(context.request, rawBody, context.env.META_APP_SECRET)) {
      return new Response("Invalid signature", { status: 401 });
    }
    const body = JSON.parse(new TextDecoder().decode(rawBody));
    const db = context.env.DB;
    if (!db) return new Response("Inbox database is not configured", { status: 503 });
    await ensureWhatsAppInbox(db);

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        for (const status of value.statuses || []) {
          await db.prepare("UPDATE whatsapp_messages SET status=? WHERE message_id=? AND direction='outbound'")
            .bind(String(status.status || "unknown").slice(0, 32), String(status.id || "")).run();
        }
        const contacts = value.contacts || [];
        for (const message of value.messages || []) {
          if (!message.id || !message.from) continue;
          let phone = String(message.from).replace(/\D/g, "");
          // Preserve the existing Mexico destination normalization used by the bot.
          if (phone.startsWith('521') && phone.length === 13) phone = '52' + phone.slice(3);
          if (!phone) continue;
          const contact = contacts.find(item => item.wa_id === message.from);
          const contactName = String(contact?.profile?.name || "").trim().slice(0, 120);
          const userText = messageText(message).slice(0, 4000);
          const createdAt = new Date(Number(message.timestamp || Math.floor(Date.now() / 1000)) * 1000).toISOString();
          const isNew = await saveWhatsAppMessage(db, {
            id: String(message.id), phone, contactName, direction: "inbound",
            type: String(message.type || "unknown"), body: userText, createdAt
          });
          if (!isNew) continue;

          if (contactName) {
            await db.prepare(`UPDATE whatsapp_messages SET contact_name=? WHERE phone=? AND (contact_name IS NULL OR contact_name='')`)
              .bind(contactName, phone).run();
          }
          if (message.type !== "text" || !userText) continue;

          const geminiKey = context.env.GEMINI_API_KEY;
          const botReply = await consultarGemini(userText, geminiKey) ||
            "¡Hola! Gracias por comunicarte con MMH Builds. ¿En qué computadora o componente te podemos asesorar hoy?";
          const phoneId = context.env.WHATSAPP_PHONE_ID;
          const token = context.env.WHATSAPP_TOKEN;
          if (!phoneId || !token) continue;

          const sendResponse = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ messaging_product: "whatsapp", to: phone, text: { body: botReply } })
          });
          const sent = await sendResponse.json().catch(() => ({}));
          if (!sendResponse.ok) {
            console.error("WhatsApp no aceptó la respuesta automática.", sendResponse.status);
            continue;
          }
          const sentMessage = sent.messages?.[0];
          if (sentMessage?.id) {
            await saveWhatsAppMessage(db, {
              id: String(sentMessage.id), phone, contactName, direction: "outbound",
              type: "text", body: botReply.slice(0, 4000), status: "sent", createdAt: new Date().toISOString()
            });
          }
        }
      }
    }
    return new Response("EVENT_RECEIVED", { status: 200 });
  } catch (err) {
    console.error("No se pudo guardar o procesar el webhook de WhatsApp.", err.name || "Error");
    return new Response("Webhook processing failed", { status: 500 });
  }
}
