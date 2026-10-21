// Función inteligente que detecta y consulta el modelo activo de Gemini
async function consultarGemini(userText, geminiKey) {
  if (!geminiKey) return null;

  const prompt = `Eres el asesor virtual experto de "MMH Builds", tienda de PCs gamer y workstation de alto rendimiento en México.
Tu tono es experto, profesional, entusiasta y muy amable.
El cliente te escribió por WhatsApp: "${userText}".
Responde de forma clara, breve (estilo WhatsApp) y útil. Si te preguntan por un ensamble o cotización, pregunta qué uso le darán (gaming, render, oficina) y su presupuesto. Si te dan un folio (ejemplo MMH-...), diles con gusto que el equipo técnico revisará las piezas para confirmar existencia.`;

  // 1. Detectamos automáticamente qué modelo tiene activo tu clave en Google
  let modelo = "gemini-2.5-flash";
  try {
    const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`);
    if (listRes.ok) {
      const data = await listRes.json();
      const modelEncontrado = data.models?.find(m => 
        m.supportedGenerationMethods?.includes("generateContent") && 
        (m.name.includes("flash") || m.name.includes("pro"))
      );
      if (modelEncontrado) {
        modelo = modelEncontrado.name.replace("models/", "");
      }
    }
  } catch (e) {
    modelo = "gemini-2.5-flash";
  }

  // 2. Generamos la respuesta con el modelo detectado
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${geminiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });

    if (res.ok) {
      const data = await res.json();
      const texto = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (texto) {
        return { modeloUsado: modelo, respuesta: texto };
      }
    }
  } catch (e) {}

  return null;
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);

  // MODO DIAGNÓSTICO
  if (url.searchParams.get("test") === "1") {
    const geminiKey = context.env.GEMINI_API_KEY;
    const resultado = await consultarGemini("Dame una recomendación de tarjeta gráfica para gaming a 1080p.", geminiKey);

    return new Response(JSON.stringify({
      version_codigo: "V3_AUTODETECT",
      gemini_conectado_con_exito: !!resultado,
      resultado: resultado || "Error al conectar con Google"
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

    // Consultamos a Gemini con el auto-detector
    let botReply = "¡Hola! Gracias por comunicarte con MMH Builds. ¿En qué computadora o componente te podemos asesorar hoy?";
    const geminiKey = context.env.GEMINI_API_KEY;

    if (geminiKey) {
      const ia = await consultarGemini(userText, geminiKey);
      if (ia && ia.respuesta) {
        botReply = ia.respuesta;
      }
    }

    // Responder por WhatsApp
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
