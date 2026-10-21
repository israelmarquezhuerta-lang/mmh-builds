export async function onRequestGet(context) {
  const url = new URL(context.request.url);

  // MODO DIAGNÓSTICO DETALLADO DE GOOGLE
  if (url.searchParams.get("test") === "1") {
    const geminiKey = context.env.GEMINI_API_KEY;

    let listaModelos = null;
    let intentoGenerar = null;

    if (geminiKey) {
      // 1. Ver qué responde Google al pedir la lista de modelos
      try {
        const resList = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`);
        const dataList = await resList.json();
        listaModelos = { status: resList.status, data: dataList };
      } catch (e) {
        listaModelos = { error: e.message };
      }

      // 2. Ver qué responde Google al intentar generar texto
      try {
        const resGen = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: "Hola" }] }]
          })
        });
        const dataGen = await resGen.json();
        intentoGenerar = { status: resGen.status, data: dataGen };
      } catch (e) {
        intentoGenerar = { error: e.message };
      }
    }

    return new Response(JSON.stringify({
      clave_presente: !!geminiKey,
      google_lista_modelos: listaModelos,
      google_intento_generar: intentoGenerar
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
        const prompt = `Eres el asesor virtual de "MMH Builds", tienda de PCs de alto rendimiento en México. Responde amable, breve y experto por WhatsApp a: "${userText}". Si piden cotización, pregunta qué componentes buscan o presupuesto.`;
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        const data = await res.json();
        const texto = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (texto) botReply = texto;
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
