export async function onRequestGet(context) {
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

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (!message || message.type !== "text") {
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    let from = message.from; // Número del cliente
    
    // Parche para México: si viene como 521XXXXXXXXXX se limpia a 52XXXXXXXXXX
    if (from.startsWith("521") && from.length === 13) {
      from = "52" + from.substring(3);
    }

    const userText = message.text.body;

    // 1. Consultar a Gemini (IA)
    let botReply = "¡Hola! Gracias por comunicarte con MMH Builds. ¿En qué computadora o componente te podemos asesorar hoy?";
    const geminiKey = context.env.GEMINI_API_KEY;

    if (geminiKey) {
      try {
        const prompt = `Eres el asesor virtual de "MMH Builds", tienda de computadoras gamer y componentes de alto rendimiento en México.
Responde de forma amable, experta y breve por WhatsApp al cliente que te escribió: "${userText}".
Si te piden cotización, pregunta qué componentes buscan o su presupuesto. Si te dan un folio (ej. MMH-...), diles que el equipo técnico revisará las piezas para confirmar existencia.`;

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
      } catch (e) {
        console.error("Error llamando a Gemini:", e);
      }
    }

    // 2. Responder por WhatsApp mediante Meta Graph API
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
    console.error("Error general:", err);
    return new Response("OK", { status: 200 });
  }
}
