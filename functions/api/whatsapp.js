async function llamarGemini(userText, geminiKey) {
  if (!geminiKey) return null;

  const prompt = `Eres el asesor virtual inteligente de "MMH Builds", una tienda y taller de ensamble de computadoras de alto rendimiento y venta de componentes (tarjetas RTX, procesadores Ryzen/Intel, etc.) en México.
Tu tono es experto, profesional, entusiasta y muy amable.
El cliente te escribió por WhatsApp: "${userText}".
Responde de forma clara, breve (estilo mensaje de WhatsApp) y útil en español de México. Si te preguntan por una cotización o ensamble, pregunta el uso principal (gaming, render, oficina) y su presupuesto. Si te dan un folio (ejemplo MMH-...), diles con gusto que el equipo técnico revisará los componentes para confirmar disponibilidad.`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });

    if (res.ok) {
      const data = await res.json();
      // En Gemini 2.5 tomamos el texto generado del candidato
      const parts = data.candidates?.[0]?.content?.parts || [];
      const textPart = parts.find(p => p.text && !p.thought) || parts[parts.length - 1];
      if (textPart && textPart.text) {
        return textPart.text;
      }
    }
  } catch (e) {
    console.error("Error en llamada Gemini:", e);
  }
  return null;
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);

  // MODO TEST
  if (url.searchParams.get("test") === "1") {
    const geminiKey = context.env.GEMINI_API_KEY;
    const respuestaIA = await llamarGemini("Hola, recomiéndame una tarjeta de video para jugar a 1080p con buen rendimiento.", geminiKey);

    return new Response(JSON.stringify({
      estado_ia: respuestaIA ? "FUNCIONANDO_AL_100" : "ERROR",
      respuesta_generada_por_gemini: respuestaIA
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

    // Consultamos a Gemini 2.5 Flash
    const geminiKey = context.env.GEMINI_API_KEY;
    let botReply = await llamarGemini(userText, geminiKey);

    if (!botReply) {
      botReply = "¡Hola! Gracias por comunicarte con MMH Builds. ¿En qué computadora o componente te podemos asesorar hoy?";
    }

    // Responder por WhatsApp oficial
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
