export async function onRequestGet(context) {
  // Verificación del Webhook por parte de Meta
  const url = new URL(context.request.url);
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

    // Verificamos si es un mensaje de texto entrante de WhatsApp
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (!message || message.type !== "text") {
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    const from = message.from; // Número del cliente
    const userText = message.text.body; // Mensaje que escribió el cliente

    // 1. Consultar a Gemini (IA)
    const geminiKey = context.env.GEMINI_API_KEY;
    const prompt = `Eres el asesor virtual inteligente de "MMH Builds", una tienda y taller especializado en ensamble de computadoras de alto rendimiento y venta de componentes (tarjetas de video RTX, procesadores Ryzen/Intel, etc.) en México.
Tu tono es experto, profesional, entusiasta y muy amable.
El cliente te acaba de escribir por WhatsApp: "${userText}".
Responde de forma clara, breve (estilo WhatsApp) y útil. Si te preguntan por un ensamble o cotización, pregunta qué uso le darán (gaming, render, oficina) y su presupuesto. Si te dan un folio (ejemplo MMH-...), diles con gusto que el equipo técnico revisará las piezas para confirmar existencia.`;

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`;
    const geminiRes = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });

    const geminiData = await geminiRes.json();
    const botReply = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "¡Hola! Gracias por comunicarte con MMH Builds. Un asesor te responderá enseguida.";

    // 2. Responder al cliente por WhatsApp mediante Meta Graph API
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
    console.error("Error en WhatsApp bot:", err);
    return new Response("OK", { status: 200 });
  }
}
