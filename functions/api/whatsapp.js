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
    }, null
