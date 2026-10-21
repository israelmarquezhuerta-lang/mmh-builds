import { handleAdmin as handleWhatsAppAdmin } from '../_lib/whatsapp.js';
import chatConfig from "../../chat-config.js";
import loyalty from "../../loyalty.js";
import catalog from "../../catalog.js";
import payments from "../../payments.js";

const {
  MODEL,
  MAX_MESSAGES,
  MAX_MESSAGE_LENGTH,
  RATE_WINDOW_MS,
  RATE_LIMIT,
  SYSTEM_INSTRUCTION
} = chatConfig;
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const passwordResetLifetimeMs = 30 * 60 * 1000;
const passwordHashIterations = 100_000;
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
    { name: "PBKDF2", hash: "SHA-256", salt: bytesFromHex(salt), iterations: passwordHashIterations },
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

async function sendPasswordResetEmail(env, email, resetUrl) {
  const response = await fetch(env.GOOGLE_APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: env.PASSWORD_RESET_MAIL_SECRET, email, resetUrl }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Google Apps Script respondió con estado ${response.status}.`);
  const result = await response.json();
  if (!result?.ok) throw new Error("Google Apps Script no confirmó el envío del correo.");
}

async function requestPasswordReset(db, request, env, input) {
  const email = normalizeEmail(input.email);
  if (!emailPattern.test(email) || email.length > 254) {
    throw apiError("Escribe un correo electrónico válido.", 400);
  }
  if (!String(env.GOOGLE_APPS_SCRIPT_URL || "").trim() || !String(env.PASSWORD_RESET_MAIL_SECRET || "").trim()) {
    throw apiError("El envío de correos de recuperación todavía no está configurado. Contacta a MMH para recuperar tu cuenta.", 503);
  }

  const customer = await db.prepare("SELECT email FROM customers WHERE email = ?").bind(email).first();
  if (!customer) return { ok: true };

  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await db.batch([
    db.prepare("DELETE FROM password_reset_tokens WHERE expires_at <= ? OR email = ?").bind(now, email),
    db.prepare("INSERT INTO password_reset_tokens (token_hash, email, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256(token), email, now + passwordResetLifetimeMs, new Date(now).toISOString())
  ]);

  try {
    const base = new URL(String(env.APP_BASE_URL || new URL(request.url).origin));
    if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname))) {
      throw new Error("APP_BASE_URL debe usar HTTPS.");
    }
    base.pathname = "/";
    base.search = "";
    base.hash = `reset-password=${token}`;
    await sendPasswordResetEmail(env, email, base.toString());
  } catch (error) {
    console.error("No se pudo enviar el correo de recuperación de contraseña.", error.message);
    await db.prepare("DELETE FROM password_reset_tokens WHERE token_hash = ?").bind(await sha256(token)).run();
  }
  return { ok: true };
}

async function completePasswordReset(db, input) {
  const token = String(input.token || "");
  const password = String(input.password || "");
  if (!/^[a-f0-9]{64}$/.test(token) || password.length < 8 || password.length > 256) {
    throw apiError("El enlace no es válido o ya venció. Solicita uno nuevo.", 400);
  }
  const tokenHash = await sha256(token);
  const now = Date.now();
  const reset = await db.prepare("SELECT email FROM password_reset_tokens WHERE token_hash = ? AND expires_at > ?")
    .bind(tokenHash, now)
    .first();
  if (!reset) throw apiError("El enlace no es válido o ya venció. Solicita uno nuevo.", 400);

  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await passwordHash(password, salt);
  const result = await db.batch([
    db.prepare(`UPDATE customers SET salt = ?, password_hash = ? WHERE email = ?
      AND EXISTS (SELECT 1 FROM password_reset_tokens WHERE token_hash = ? AND expires_at > ?)`)
      .bind(salt, hash, reset.email, tokenHash, now),
    db.prepare(`DELETE FROM sessions WHERE email = ? AND EXISTS (
      SELECT 1 FROM password_reset_tokens WHERE token_hash = ? AND expires_at > ?)`)
      .bind(reset.email, tokenHash, now),
    db.prepare("DELETE FROM password_reset_tokens WHERE email = ? AND token_hash = ?")
      .bind(reset.email, tokenHash)
  ]);
  if (!result[0]?.meta?.changes) throw apiError("El enlace no es válido o ya venció. Solicita uno nuevo.", 400);
  return { ok: true };
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

function orderFromRow(row) {
  return {
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
  };
}

async function listOrders(db, email) {
  const result = await db.prepare("SELECT * FROM orders WHERE email = ? ORDER BY created_at ASC").bind(email).all();
  return (result.results || []).map(orderFromRow);
}

async function getOrderForCustomer(db, email, id) {
  const row = await db.prepare("SELECT * FROM orders WHERE id = ? AND email = ?").bind(id, email).first();
  return row ? { ...orderFromRow(row), paymentIntentId: row.payment_intent_id } : null;
}

function requireStripe(env) {
  if (!payments.isConfigured(env)) {
    throw apiError("El pago con tarjeta no está disponible temporalmente. Tu pedido está guardado; inténtalo de nuevo más tarde.", 503);
  }
}

async function markOrderPaid(db, order, intent) {
  if (!payments.paymentMatchesOrder(intent, order)) return false;
  await db.prepare("UPDATE orders SET payment_status = ?, payment = ?, payment_intent_id = ? WHERE id = ? AND payment_status != ?")
    .bind(payments.paidStatus, "Tarjeta (Stripe)", intent.id, order.id, payments.paidStatus)
    .run();
  return true;
}

async function startOrderPayment(db, env, email, id) {
  requireStripe(env);
  const order = await getOrderForCustomer(db, email, id);
  if (!order) throw apiError("No se encontró ese pedido.", 404);
  if (order.paymentStatus === payments.paidStatus) throw apiError("Este pedido ya está pagado.", 409);
  if (order.quoteRequired || !(order.total > 0)) {
    throw apiError("Este pedido incluye servicios por cotizar. MMH te confirmará el precio antes del pago.", 409);
  }
  const currentPrices = catalog.priceOrderItems(order.items);
  if (!currentPrices || Math.abs(currentPrices.subtotal - order.subtotal) > 0.005) {
    throw apiError("El catálogo cambió desde que registraste el pedido. Revisa tu selección y registra un pedido actualizado.", 409);
  }
  const row = await db.prepare("SELECT stripe_customer_id FROM customers WHERE email = ?").bind(email).first();
  const stripeCustomerId = await payments.ensureCustomer(env.STRIPE_SECRET_KEY, row?.stripe_customer_id, order.customer);
  if (!row?.stripe_customer_id) {
    await db.prepare("UPDATE customers SET stripe_customer_id = ? WHERE email = ?").bind(stripeCustomerId, email).run();
  }
  const intent = await payments.createOrReusePaymentIntent(env.STRIPE_SECRET_KEY, { order, stripeCustomerId });
  if (intent.status === "succeeded") {
    await markOrderPaid(db, order, intent);
    throw apiError("Este pedido ya está pagado.", 409);
  }
  if (intent.id !== order.paymentIntentId) {
    await db.prepare("UPDATE orders SET payment_intent_id = ? WHERE id = ?").bind(intent.id, order.id).run();
  }
  return {
    clientSecret: intent.client_secret,
    customerId: stripeCustomerId,
    publishableKey: env.STRIPE_PUBLISHABLE_KEY,
    amount: order.total,
    currency: payments.currency
  };
}

async function syncOrderPayment(db, env, email, id) {
  requireStripe(env);
  const order = await getOrderForCustomer(db, email, id);
  if (!order) throw apiError("No se encontró ese pedido.", 404);
  let status = order.paymentStatus === payments.paidStatus ? "succeeded" : "requires_payment_method";
  if (status !== "succeeded" && order.paymentIntentId) {
    const intent = await payments.retrievePaymentIntent(env.STRIPE_SECRET_KEY, order.paymentIntentId);
    status = intent.status;
    if (status === "succeeded" && !(await markOrderPaid(db, order, intent))) status = "mismatch";
  }
  const { paymentIntentId, ...updated } = await getOrderForCustomer(db, email, id);
  return { order: updated, status };
}

async function handleStripeWebhook(request, env) {
  const db = getDatabase(env);
  const rawBody = await request.text();
  if (rawBody.length > maxBodyBytes * 4) return json(413, { error: "La solicitud es demasiado grande." });
  const event = await payments.verifyWebhook(rawBody, request.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET);
  if (!event) return json(400, { error: "Firma de webhook no válida." });
  if (event.type === "payment_intent.succeeded") {
    const intent = event.data.object;
    const row = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(String(intent.metadata?.order_id || "")).first();
    if (!row || !(await markOrderPaid(db, orderFromRow(row), intent))) {
      console.error("Pago de Stripe sin pedido coincidente:", intent.id);
    }
  }
  return json(200, { received: true });
}

async function getCustomerLoyalty(db, email) {
  const result = await db.prepare("SELECT subtotal, total, payment_status FROM orders WHERE email = ? AND payment_status = ?")
    .bind(email, "Pago verificado")
    .all();
  return loyalty.calculateLoyalty(result.results || []);
}

async function createOrder(db, email, input) {
  const priced = catalog.priceOrderItems(input.items);
  if (!priced) throw apiError("El pedido no contiene artículos válidos.", 400);
  const customer = {
    name: String(input.customer?.name || "").trim().slice(0, 100),
    email,
    phone: String(input.customer?.phone || "").trim().slice(0, 30),
    address: String(input.customer?.address || "").trim().slice(0, 300)
  };
  if (!customer.name || !customer.phone || !customer.address) {
    throw apiError("Revisa los datos del pedido y vuelve a intentar.", 400);
  }

  const { items, subtotal, quoteRequired } = priced;
  const loyalty = await getCustomerLoyalty(db, email);
  const discountRate = catalog.APPLY_LOYALTY_DISCOUNTS ? loyalty.discountPercent : 0;
  const discountAmount = Math.round(subtotal * discountRate) / 100;
  const order = {
    id: `MMH-${hex(crypto.getRandomValues(new Uint8Array(4))).toUpperCase()}`,
    subtotal,
    discountRate,
    discountAmount,
    total: subtotal - discountAmount,
    payment: quoteRequired ? "Por acordar tras la cotización de MMH" : "Tarjeta (Stripe)",
    paymentStatus: quoteRequired ? "Pendiente de confirmación de cotización por MMH" : payments.unpaidStatus,
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

async function handleLocal(request, env, pathname) {
  if (!["GET", "HEAD"].includes(request.method) && request.headers.get("Origin") !== new URL(request.url).origin) return json(403, { error: "Solicitud no autorizada desde este origen." });
  const db = getDatabase(env);
  const token = getSessionToken(request);
  const customer = await findSession(db, token);
  if (pathname.startsWith("/api/local/admin/")) {
    const admins = String(env.MMH_ADMIN_EMAILS || "").split(",").map(email => email.trim().toLowerCase()).filter(Boolean);
    if (!customer || !admins.includes(customer.email.toLowerCase())) return json(403, { error: "Este espacio es exclusivo de administración." });
    if (pathname === "/api/local/admin/whatsapp" || pathname.startsWith("/api/local/admin/whatsapp/")) {
      if (request.method === "POST" && await enforceRateLimit(db, request, "whatsapp-admin", 60, 60_000)) return json(429, { error: "Espera un minuto antes de continuar." });
      return await handleWhatsAppAdmin(request, env, db, pathname, customer.email, readJson);
    }
    if (pathname === "/api/local/admin/orders" && request.method === "GET") {
      const rows = await db.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT 200").all();
      return json(200, { orders: (rows.results || []).map(orderFromRow) });
    }
    const stageMatch = pathname.match(/^\/api\/local\/admin\/orders\/(MMH-[A-F0-9]{8})\/stage$/);
    if (stageMatch && request.method === "POST") {
      const input = await readJson(request); const stage = Number(input.stage);
      if (!Number.isInteger(stage) || stage < 0 || stage > 6) return json(400, { error: "Etapa no válida." });
      const row = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(stageMatch[1]).first();
      if (!row) return json(404, { error: "No se encontró el pedido." });
      if (!row.quote_required && row.payment_status !== payments.paidStatus && stage > 0) return json(409, { error: "El pedido debe tener un pago verificado antes de preparar el equipo." });
      await db.prepare("UPDATE orders SET stage = ? WHERE id = ?").bind(stage,stageMatch[1]).run();
      return json(200,{ok:true});
    }
    return json(404,{error:"No se encontró esa operación administrativa."});
  }

  if (pathname === "/api/local/password-reset/request" && request.method === "POST") {
    if (await enforceRateLimit(db, request, "password-reset-request", 5, authRateWindowMs)) {
      return json(429, { error: "Has solicitado varios enlaces. Espera unos minutos e inténtalo de nuevo." });
    }
    return json(200, await requestPasswordReset(db, request, env, await readJson(request)));
  }
  if (pathname === "/api/local/password-reset/complete" && request.method === "POST") {
    if (await enforceRateLimit(db, request, "password-reset-complete", 10, authRateWindowMs)) {
      return json(429, { error: "Has enviado varias solicitudes. Espera unos minutos e inténtalo de nuevo." });
    }
    await completePasswordReset(db, await readJson(request));
    return json(200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
  }
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
  const paymentMatch = pathname.match(/^\/api\/local\/orders\/(MMH-[A-F0-9]{8})\/(payment-intent|payment-status)$/);
  if (paymentMatch && request.method === "POST") {
    if (!customer) return json(401, { error: "Inicia sesión para pagar tu pedido." });
    if (await enforceRateLimit(db, request, "payment", 30, authRateWindowMs)) {
      return json(429, { error: "Has hecho varios intentos de pago. Espera unos minutos e inténtalo de nuevo." });
    }
    if (paymentMatch[2] === "payment-intent") return json(200, await startOrderPayment(db, env, customer.email, paymentMatch[1]));
    return json(200, await syncOrderPayment(db, env, customer.email, paymentMatch[1]));
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
    if (pathname === "/api/stripe/webhook" && request.method === "POST") return await handleStripeWebhook(request, env);
    if (pathname.startsWith("/api/local/")) return await handleLocal(request, env, pathname);
    return json(404, { error: "No se encontró esa función." });
  } catch (error) {
    console.error("Error de API MMH Builds:", error.message);
    return json(error.status || 500, {
      error: error.status ? error.message : "No se pudo completar la operación."
    });
  }
}
