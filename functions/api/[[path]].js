import "../../chat-config.js";
import "../../loyalty.js";

const {
  MODEL,
  MAX_MESSAGES,
  MAX_MESSAGE_LENGTH,
  RATE_WINDOW_MS,
  RATE_LIMIT,
  SYSTEM_INSTRUCTION
} = globalThis.MmhChatConfig;
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const maxBodyBytes = 64 * 1024;
const rateCleanupIntervalMs = 10 * 60 * 1000;
const authRateWindowMs = 10 * 60 * 1000;
let lastRateCleanup = 0;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers
    }
  });
}

function apiError(message, status) {
  return Object.assign(new Error(message), { status });
}

function hex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function bytesFromHex(value) {
  return new Uint8Array(value.match(/.{2}/g).map(pair => Number.parseInt(pair, 16)));
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return hex(new Uint8Array(digest));
}

async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: bytesFromHex(salt), iterations: 120000 },
    key,
    256
  );
  return hex(new Uint8Array(derived));
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function getDatabase(env) {
  if (!env.DB || typeof env.DB.prepare !== "function") {
    throw apiError("La base de datos del sitio todavía no está configurada.", 503);
  }
  return env.DB;
}

async function readJson(request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > maxBodyBytes) throw apiError("La solicitud es demasiado grande.", 413);
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBodyBytes) {
      await reader.cancel();
      throw apiError("La solicitud es demasiado grande.", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const body = new TextDecoder().decode(bytes);
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw apiError("El cuerpo de la solicitud no es JSON válido.", 400);
  }
}

function customerFromRow(row) {
  return row ? { name: row.name, email: row.email, phone: row.phone, address: row.address } : null;
}

function getSessionToken(request) {
  const cookie = (request.headers.get("cookie") || "")
    .split(";")
    .map(value => value.trim())
    .find(value => value.startsWith("mmh_local_session="));
  if (!cookie) return "";
  try {
    return decodeURIComponent(cookie.slice("mmh_local_session=".length));
  } catch {
    return "";
  }
}

async function findSession(db, token) {
  if (!token) return null;
  const row = await db.prepare(`SELECT customers.name, customers.email, customers.phone, customers.address
    FROM sessions JOIN customers ON customers.email = sessions.email
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?`)
    .bind(await sha256(token), Date.now())
    .first();
  return customerFromRow(row);
}

function setSessionCookie(token) {
  return `mmh_local_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=2592000`;
}

function clearSessionCookie() {
  return "mmh_local_session=; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=0";
}

async function createSession(db, email) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  await db.prepare("INSERT INTO sessions (token_hash, email, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(token), email, Date.now() + sessionLifetimeMs)
    .run();
  return token;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

async function register(db, input) {
  const email = normalizeEmail(input.email);
  const name = String(input.name || "").trim();
  const phone = String(input.phone || "").trim();
  const address = String(input.address || "").trim();
  const password = String(input.password || "");
  if (!name || name.length > 100 || !emailPattern.test(email) || email.length > 254 ||
    !phone || phone.length > 30 || !address || address.length > 300 || password.length < 8 || password.length > 256) {
    throw apiError("Completa tus datos y usa una contraseña de al menos 8 caracteres.", 400);
  }

  if (await db.prepare("SELECT 1 FROM customers WHERE email = ?").bind(email).first()) {
    throw apiError("Ya existe una cuenta con ese correo. Inicia sesión.", 409);
  }

  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await passwordHash(password, salt);
  await db.prepare(`INSERT INTO customers (email, name, phone, address, salt, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(email, name, phone, address, salt, hash, new Date().toISOString())
    .run();
  const token = await createSession(db, email);
  return { customer: { name, email, phone, address }, token };
}

async function login(db, input) {
  const email = normalizeEmail(input.email);
  const row = await db.prepare("SELECT * FROM customers WHERE email = ?").bind(email).first();
  const salt = row?.salt || "00000000000000000000000000000000";
  const suppliedHash = await passwordHash(String(input.password || "").slice(0, 256), salt);
  if (!row || !constantTimeEqual(suppliedHash, row.password_hash)) {
    throw apiError("Correo o contraseña incorrectos.", 401);
  }
  return { customer: customerFromRow(row), token: await createSession(db, email) };
}

async function createVisitorLead(db, input) {
  const name = String(input.name || "").trim().replace(/\s+/g, " ").slice(0, 100);
  const phone = String(input.phone || "").trim().slice(0, 20);
  const phoneDigits = phone.replace(/\D/g, "");
  if (name.length < 2 || !/^[\p{L}\p{M} .'-]+$/u.test(name) ||
    phoneDigits.length < 10 || phoneDigits.length > 15 || !/^[0-9+() .-]+$/.test(phone)) {
    throw apiError("Escribe un nombre y un teléfono válidos (10 a 15 dígitos).", 400);
  }
  const createdAt = new Date().toISOString();
  const result = await db.prepare("INSERT INTO visitor_leads (name, phone, created_at) VALUES (?, ?, ?)")
    .bind(name, phone, createdAt)
    .run();
  return { id: Number(result.meta.last_row_id), name, phone, createdAt };
}

async function listOrders(db, email) {
  const result = await db.prepare("SELECT * FROM orders WHERE email = ? ORDER BY created_at ASC").bind(email).all();
  return (result.results || []).map(row => ({
    id: row.id,
    subtotal: row.subtotal,
    discountRate: row.discount_rate,
    discountAmount: row.discount_amount,
    total: row.total,
    payment: row.payment,
    paymentStatus: row.payment_status,
    quoteRequired: Boolean(row.quote_required),
    customer: JSON.parse(row.customer_json),
    createdAt: row.created_at,
    stage: row.stage,
    items: JSON.parse(row.items_json)
  }));
}

async function getCustomerLoyalty(db, email) {
  const result = await db.prepare("SELECT subtotal, total, payment_status FROM orders WHERE email = ? AND payment_status = ?")
    .bind(email, "Pago verificado")
    .all();
  return globalThis.MmhLoyalty.calculateLoyalty(result.results || []);
}

async function createOrder(db, email, input) {
  if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > 40) {
    throw apiError("El pedido no contiene artículos válidos.", 400);
  }
  const customer = {
    name: String(input.customer?.name || "").trim().slice(0, 100),
    email,
    phone: String(input.customer?.phone || "").trim().slice(0, 30),
    address: String(input.customer?.address || "").trim().slice(0, 300)
  };
  const items = input.items.map(item => ({
    product: {
      id: String(item.product?.id || "").slice(0, 80),
      name: String(item.product?.name || "Artículo").slice(0, 180),
      priceOnQuote: Boolean(item.product?.priceOnQuote),
      referencePrice: Number(item.product?.referencePrice || item.product?.price || 0)
    },
    quantity: Math.min(99, Math.max(1, Math.floor(Number(item.quantity) || 1)))
  }));
  const total = Number(input.total);
  if (!Number.isFinite(total) || total < 0 || !customer.name || !customer.phone || !customer.address ||
    items.some(item => !Number.isFinite(item.product.referencePrice) || item.product.referencePrice < 0)) {
    throw apiError("Revisa los datos del pedido y vuelve a intentar.", 400);
  }

  const quoteRequired = Boolean(input.quoteRequired);
  const loyalty = await getCustomerLoyalty(db, email);
  const subtotal = total;
  const discountRate = loyalty.discountPercent;
  const discountAmount = Math.round(subtotal * discountRate) / 100;
  const order = {
    id: `MMH-${hex(crypto.getRandomValues(new Uint8Array(4))).toUpperCase()}`,
    subtotal,
    discountRate,
    discountAmount,
    total: subtotal - discountAmount,
    payment: String(input.payment || "Por acordar tras la confirmación de MMH").slice(0, 80),
    paymentStatus: quoteRequired ? "Pendiente de confirmación de cotización por MMH" : "Pendiente de confirmación por MMH",
    quoteRequired,
    customer,
    createdAt: new Date().toISOString(),
    stage: 0,
    items
  };

  await db.prepare("UPDATE customers SET name = ?, phone = ?, address = ? WHERE email = ?")
    .bind(customer.name, customer.phone, customer.address, email)
    .run();
  await db.prepare(`INSERT INTO orders (id, email, subtotal, discount_rate, discount_amount, total,
    payment, payment_status, quote_required, customer_json, items_json, created_at, stage)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(order.id, email, order.subtotal, order.discountRate, order.discountAmount, order.total,
      order.payment, order.paymentStatus, Number(order.quoteRequired),
      JSON.stringify(order.customer), JSON.stringify(order.items), order.createdAt, order.stage)
    .run();
  return order;
}

async function updateOrderStage(db, email, id, stage) {
  const safeStage = Math.min(6, Math.max(0, Math.floor(Number(stage) || 0)));
  const result = await db.prepare("UPDATE orders SET stage = ? WHERE id = ? AND email = ?")
    .bind(safeStage, id, email)
    .run();
  if (!result.meta.changes) return null;
  return (await listOrders(db, email)).find(order => order.id === id) || null;
}

async function handleLocal(request, env, pathname) {
  const db = getDatabase(env);
  const token = getSessionToken(request);
  const customer = await findSession(db, token);
  if (pathname === "/api/local/visitor-leads" && request.method === "POST") {
    if (await enforceRateLimit(db, request, "visitor", 15, authRateWindowMs)) {
      return json(429, { error: "Inténtalo de nuevo más tarde para registrar otra visita." });
    }
    const lead = await createVisitorLead(db, await readJson(request));
    return json(201, { ok: true, id: lead.id });
  }
  if (pathname === "/api/local/session" && request.method === "GET") {
    return json(200, { customer });
  }
  if (pathname === "/api/local/register" && request.method === "POST") {
    if (await enforceRateLimit(db, request, "account", 20, authRateWindowMs)) {
      return json(429, { error: "Has enviado varias solicitudes. Espera unos minutos e inténtalo de nuevo." });
    }
    const result = await register(db, await readJson(request));
    return json(201, { customer: result.customer }, { "Set-Cookie": setSessionCookie(result.token) });
  }
  if (pathname === "/api/local/login" && request.method === "POST") {
    if (await enforceRateLimit(db, request, "account", 20, authRateWindowMs)) {
      return json(429, { error: "Has enviado varios intentos. Espera unos minutos e inténtalo de nuevo." });
    }
    const result = await login(db, await readJson(request));
    return json(200, { customer: result.customer }, { "Set-Cookie": setSessionCookie(result.token) });
  }
  if (pathname === "/api/local/logout" && request.method === "POST") {
    if (token) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
    return json(200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
  }
  if (pathname === "/api/local/orders" && request.method === "GET") {
    if (!customer) return json(401, { error: "Inicia sesión para ver tus pedidos." });
    return json(200, { orders: await listOrders(db, customer.email) });
  }
  if (pathname === "/api/local/orders" && request.method === "POST") {
    if (!customer) return json(401, { error: "Inicia sesión para registrar un pedido." });
    return json(201, { order: await createOrder(db, customer.email, await readJson(request)) });
  }
  const orderMatch = pathname.match(/^\/api\/local\/orders\/([A-Za-z0-9-]+)$/);
  if (orderMatch && request.method === "PATCH") {
    if (!customer) return json(401, { error: "Inicia sesión para actualizar el pedido." });
    const order = await updateOrderStage(db, customer.email, orderMatch[1], (await readJson(request)).stage);
    if (!order) return json(404, { error: "No se encontró ese pedido." });
    return json(200, { order });
  }
  if (pathname.startsWith("/api/local/")) {
    return json(404, { error: "No se encontró esa función local." });
  }
  return json(404, { error: "No se encontró esa función." });
}

async function enforceRateLimit(db, request, scope, limit, windowMs) {
  const ip = request.headers.get("cf-connecting-ip") ||
    (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  const clientHash = await sha256(`${scope}:${ip}`);
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  await db.prepare(`INSERT INTO request_rate_limits (client_hash, window_start, count)
    VALUES (?, ?, 1)
    ON CONFLICT(client_hash) DO UPDATE SET
      window_start = excluded.window_start,
      count = CASE WHEN request_rate_limits.window_start = excluded.window_start
        THEN request_rate_limits.count + 1 ELSE 1 END`)
    .bind(clientHash, windowStart)
    .run();
  if (now - lastRateCleanup >= rateCleanupIntervalMs) {
    lastRateCleanup = now;
    await db.prepare("DELETE FROM request_rate_limits WHERE window_start < ?")
      .bind(now - Math.max(rateCleanupIntervalMs, windowMs))
      .run();
  }
  const row = await db.prepare("SELECT count FROM request_rate_limits WHERE client_hash = ?")
    .bind(clientHash)
    .first();
  return Number(row?.count || 0) > limit;
}

async function handleChat(request, env) {
  if (request.method !== "POST") {
    return json(405, { error: "Este endpoint solo acepta mensajes POST." }, { Allow: "POST" });
  }
  if (!env.GEMINI_API_KEY) {
    return json(503, { error: "El asistente IA todavía no está configurado en el servidor." });
  }
  const body = await readJson(request);
  const inputMessages = body.messages;
  if (!Array.isArray(inputMessages) || inputMessages.length === 0 || inputMessages.length > MAX_MESSAGES) {
    return json(400, { error: "La conversación no tiene un formato válido." });
  }
  const channel = body.channel;
  if (!["welcome", "account", "app"].includes(channel)) {
    return json(400, { error: "El canal de conversación no tiene un formato válido." });
  }

  const messages = [];
  for (const message of inputMessages) {
    if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string") {
      return json(400, { error: "La conversación contiene un mensaje no válido." });
    }
    const content = message.content.trim();
    if (!content || content.length > MAX_MESSAGE_LENGTH) {
      return json(400, { error: "Cada mensaje debe tener entre 1 y 1200 caracteres." });
    }
    const assistantContent = message.role === "assistant" && channel === "account"
      ? content
        .replace(/\s*Si quieres, crea tu cuenta MMH Builds para seguir conversando con el equipo y preparar una compra o cotización, sin compromiso\.?\s*$/i, "")
        .replace(/\s*[^.!?\n]{0,180}\b(?:crea|crear|registra|registrarte|regístrate|abre|abrir|invita|invitar|invitarte)\b[^.!?\n]{0,140}\b(?:cuenta|registro|perfil)\b[^.!?\n]*[.!?]?\s*$/i, "")
        .trim()
      : content;
    if (!assistantContent && message.role === "assistant" && channel === "account") continue;
    messages.push({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: assistantContent }]
    });
  }
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return json(400, { error: "Envía un mensaje antes de solicitar una respuesta." });
  }
  if (body.context !== undefined && (typeof body.context !== "string" || body.context.length > 3500)) {
    return json(400, { error: "El contexto de la conversación no tiene un formato válido." });
  }

  if (await enforceRateLimit(getDatabase(env), request, "chat", RATE_LIMIT, RATE_WINDOW_MS)) {
    return json(429, { error: "Has enviado varios mensajes seguidos. Espera un minuto e inténtalo de nuevo." });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let upstream;
  try {
    upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text: `${SYSTEM_INSTRUCTION}\n\n${channel === "welcome"
              ? "Canal: bienvenida previa al registro. Invita brevemente a crear cuenta."
              : channel === "account"
                ? "Canal: cliente con cuenta activa. No invites a crear cuenta."
                : "Canal: portal del cliente."}${body.context ? `\n\nContexto del catálogo y selección actual:\n${body.context}` : ""}`
          }]
        },
        contents: messages,
        generationConfig: { temperature: 0.7, maxOutputTokens: 450 }
      }),
      signal: controller.signal
    });
  } catch (error) {
    console.error("No se pudo conectar con Gemini.", error.name);
    return json(502, {
      error: error.name === "AbortError"
        ? "El asistente tardó demasiado en responder. Inténtalo de nuevo."
        : "No se pudo conectar con el asistente. Inténtalo de nuevo."
    });
  } finally {
    clearTimeout(timeout);
  }

  let result;
  try {
    result = await upstream.json();
  } catch (error) {
    console.error("Gemini devolvió una respuesta que no se pudo interpretar.", error.name);
    return json(502, { error: "El asistente devolvió una respuesta no válida. Inténtalo de nuevo." });
  }
  if (!upstream.ok) {
    console.error("Gemini rechazó la solicitud.", upstream.status);
    return json(502, { error: "El asistente no está disponible en este momento. Inténtalo de nuevo." });
  }
  const reply = result.candidates?.[0]?.content?.parts
    ?.filter(part => !part.thought)
    .map(part => part.text || "")
    .join("")
    .trim();
  if (!reply) {
    console.error("Gemini no devolvió texto utilizable.");
    return json(502, { error: "El asistente no generó una respuesta. Inténtalo de nuevo." });
  }
  return json(200, { reply });
}

export async function onRequest({ request, env }) {
  const pathname = new URL(request.url).pathname;
  try {
    if (pathname === "/api/chat") return await handleChat(request, env);
    if (pathname.startsWith("/api/local/")) return await handleLocal(request, env, pathname);
    return json(404, { error: "No se encontró esa función." });
  } catch (error) {
    console.error("Error de API MMH Builds:", error.message);
    return json(error.status || 500, {
      error: error.status ? error.message : "No se pudo completar la operación."
    });
  }
}
