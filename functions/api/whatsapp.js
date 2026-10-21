// Función para consultar a Gemini con fallback automático de modelos
async function consultarGemini(userText, geminiKey) {
  if (!geminiKey) return null;

  const prompt = `Eres el asesor virtual experto de "MMH Builds", una tienda y taller de ensamble de computadoras de alto rendimiento y venta de componentes en México.
Tu tono es experto, profesional, entusiasta y muy amable.
El cliente te escribió por WhatsApp: "${userText}".
Responde de forma clara, breve (estilo WhatsApp) y útil. Si te preguntan por un ensamble o cotización, pregunta qué uso le darán (gaming, render, oficina) y su presupuesto. Si te dan un folio (ejemplo MMH-...), diles con gusto que el equipo técnico revisará las piezas para confirmar existencia.`;

  // Modelos actuales de Google
  const modelos = [
    "gemini-2.0-flash",
    "gemini-2.5-flash",
    "gemini-1.5-flash-latest",
    "gemini-pro"
  ];

  for (const modelo of modelos) {
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
    } catch (e) {
      // Intenta el siguiente modelo
    }
  }
  return null;
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);

  // MODO DIAGNÓSTICO GEMINI
  if (url.searchParams.get("test") === "1") {
    const geminiKey = context.env.GEMINI_API_KEY;
    const resultado = await consultarGemini("Dame una recomendación rápida de tarjeta de video para jugar a 1440p.", geminiKey);

    return new Response(JSON.stringify({
      gemini_conectado_con_exito: !!resultado,
      resultado_de_gemini: resultado || "No se pudo conectar a ningún modelo"
    }, null, 2), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // Verificación Webhook Meta
  const mode = url.searchParams.get("hub.mode");
  const token = url.se
