export async function onRequestGet(context) {
  const url = new URL(context.request.url);

  // MODO ACTIVACIÓN Y DIAGNÓSTICO
  if (url.searchParams.get("test") === "1") {
    const phoneId = context.env.WHATSAPP_PHONE_ID;
    const token = context.env.WHATSAPP_TOKEN;
    const wabaId = "1680700490391181"; // Tu WABA ID de Meta

    // 1. Vincular la cuenta de WhatsApp a la app (Paso obligatorio de Meta)
    let subscribeResult = null;
    try {
      const subRes = await fetch(`https://graph.facebook.com/v21.0/${wabaId}/subscribed_apps`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`
        }
      });
      subscribeResult = await subRes.json();
    } catch (e) {
      subscribeResult = { error: e.message };
    }

    // 2. Enviar mensaje de confirmación a tu cel
    let metaResult = null;
    try {
      const metaRes = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: "522381233844",
          text: { body: "⚡ Vinculación completada: ¡El bot ya tiene permiso para escuchar y responderte!" }
        })
      });
      metaResult = await metaRes.json();
    } catch (err) {
      metaResult = { error: err.message };
    }

    return new Response(JSON.stringify({
      orden_vinculacion_meta: subscribeResult,
      mensaje_enviado: metaResult
    }, null, 2), {
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
        const prompt = `Eres el asesor virtual de "MMH Builds", tienda de PCs de alto rendimiento en México.
Responde amable, breve y experto por WhatsApp a: "${userText}". Si piden cotización, pregunta qué uso le darán o presupuesto.`;

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`;
        const geminiRes = await fetch(geminiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        const geminiData = await geminiRes.json();
        if (geminiData.candidates?.[0]?.content?.parts?.[0]?.text) {
          botReply = geminiData.candidates[0].content.parts[0].text;
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
