export async function onRequestGet(context) {
  const url = new URL(context.request.url);

  // MODO DIAGNÓSTICO GEMINI
  if (url.searchParams.get("test") === "1") {
    const geminiKey = context.env.GEMINI_API_KEY;

    let geminiStatus = null;
    let geminiResponse = null;

    try {
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`;
      const res = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "Dame una frase corta saludando a un gamer de PC." }] }]
        })
      });
      geminiStatus = res.status;
      geminiResponse = await res.json();
    } catch (err) {
      geminiResponse = { error: err.message };
    }

    return new Response(JSON.stringify({
      gemini_key_existe: !!geminiKey,
      gemini_http_status: geminiStatus,
      gemini_response: geminiResponse
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
        const prompt = `Eres el asesor virtual experto de "MMH Builds", tienda de PCs gamer y workstation de alto rendimiento en México.
Responde de forma amable, entusiasta y breve por WhatsApp al cliente que escribió: "${userText}".
Si te piden cotización, pregunta uso y presupuesto. Si dan folio, confirma que el equipo técnico revisará piezas.`;

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
