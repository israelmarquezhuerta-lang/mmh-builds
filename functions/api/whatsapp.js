export async function onRequestGet(context) {
  const url = new URL(context.request.url);

  // MODO DIAGNÓSTICO EXACTO DE ERROR
  if (url.searchParams.get("test") === "1") {
    const geminiKey = context.env.GEMINI_API_KEY;

    let debugResultado = null;
    try {
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "Hola, responde con una sola palabra." }] }]
        })
      });

      const resJson = await res.json();
      debugResultado = {
        codigo_http: res.status,
        ok: res.ok,
        respuesta_cruda_de_google: resJson
      };
    } catch (e) {
      debugResultado = { error_en_codigo: e.message };
    }

    return new Response(JSON.stringify(debugResultado, null, 2), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // Verificación normal de Webhook de Meta
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const VERIFY_TOKEN = context.env.WHATSAPP_VERIFY_TOKEN || "mmh_bot_secreto_2026";

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (!message || message.type !== "text") {
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    let from = message.from;
    if (from.startsWith("521") && from.length === 13) {
      from = "52" + from.substring(3);
    }

    const userText = message.text.body;

    let botReply = "¡Hola! Gracias por comunicarte con MMH Builds. ¿En qué computadora o componente te podemos asesorar hoy?";
    const geminiKey = context.env.GEMINI_API_KEY;

    if (geminiKey) {
      try {
        const prompt = `Eres el asesor virtual de "MMH Builds", tienda de PCs de alto rendimiento en México. Responde breve y experto por WhatsApp a: "${userText}".`;
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        if (res.ok) {
          const data = await res.json();
          const parts = data.candidates?.[0]?.content?.parts || [];
          const textPart = parts.find(p => p.text && !p.thought) || parts[parts.length - 1];
          if (textPart && textPart.text) {
            botReply = textPart.text;
          }
        }
      } catch (e) {}
    }

    const phoneId = context.env.WHATSAPP_PHONE_ID;
    const token = context.env.WHATSAPP_TOKEN;

    await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: from,
        text: { body: botReply }
      })
    });

    return new Response("OK", { status: 200 });
  } catch (err) {
    return new Response("OK", { status: 200 });
  }
}
