const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const localStore = require("./local-store");
const payments = require("./payments");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 4173);
const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 64 * 1024;
const chatHandler = require("./api/chat");

loadLocalEnvironment();

function loadLocalEnvironment() {
  const envPath = path.join(ROOT, ".env.local");
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !process.env[key]) process.env[key] = value;
  }
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw Object.assign(new Error("El mensaje es demasiado grande."), { status: 413 });
    chunks.push(chunk);
  }
  if (!length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("El cuerpo de la solicitud no es JSON válido."), { status: 400 });
  }
}

async function readRawBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES * 4) throw Object.assign(new Error("El mensaje es demasiado grande."), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function requireStripe() {
  if (!payments.isConfigured(process.env)) {
    throw Object.assign(new Error("El pago con tarjeta no está disponible temporalmente. Tu pedido está guardado; inténtalo de nuevo más tarde."), { status: 503 });
  }
}

async function startOrderPayment(email, id) {
  requireStripe();
  const order = localStore.getOrderForCustomer(email, id);
  if (!order) throw Object.assign(new Error("No se encontró ese pedido."), { status: 404 });
  if (order.paymentStatus === payments.paidStatus) throw Object.assign(new Error("Este pedido ya está pagado."), { status: 409 });
  if (order.quoteRequired || !(order.total > 0)) {
    throw Object.assign(new Error("Este pedido incluye servicios por cotizar. MMH te confirmará el precio antes del pago."), { status: 409 });
  }
  const savedCustomerId = localStore.getStripeCustomerId(email);
  const stripeCustomerId = await payments.ensureCustomer(process.env.STRIPE_SECRET_KEY, savedCustomerId, order.customer);
  if (!savedCustomerId) localStore.setStripeCustomerId(email, stripeCustomerId);
  const intent = await payments.createOrReusePaymentIntent(process.env.STRIPE_SECRET_KEY, { order, stripeCustomerId });
  if (intent.status === "succeeded") {
    localStore.markOrderPaid(order, intent);
    throw Object.assign(new Error("Este pedido ya está pagado."), { status: 409 });
  }
  if (intent.id !== order.paymentIntentId) localStore.setOrderPaymentIntent(order.id, intent.id);
  return {
    clientSecret: intent.client_secret,
    customerId: stripeCustomerId,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    amount: order.total,
    currency: payments.currency
  };
}

async function syncOrderPayment(email, id) {
  requireStripe();
  const order = localStore.getOrderForCustomer(email, id);
  if (!order) throw Object.assign(new Error("No se encontró ese pedido."), { status: 404 });
  let status = order.paymentStatus === payments.paidStatus ? "succeeded" : "requires_payment_method";
  if (status !== "succeeded" && order.paymentIntentId) {
    const intent = await payments.retrievePaymentIntent(process.env.STRIPE_SECRET_KEY, order.paymentIntentId);
    status = intent.status;
    if (status === "succeeded" && !localStore.markOrderPaid(order, intent)) status = "mismatch";
  }
  const { paymentIntentId, ...updated } = localStore.getOrderForCustomer(email, id);
  return { order: updated, status };
}

async function runStripeWebhook(req, res) {
  try {
    const event = await payments.verifyWebhook(await readRawBody(req), req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
    if (!event) return sendJson(res, 400, { error: "Firma de webhook no válida." });
    if (event.type === "payment_intent.succeeded") {
      const intent = event.data.object;
      const order = localStore.getOrderById(String(intent.metadata?.order_id || ""));
      if (!order || !localStore.markOrderPaid(order, intent)) console.error("Pago de Stripe sin pedido coincidente:", intent.id);
    }
    return sendJson(res, 200, { received: true });
  } catch (error) {
    return sendJson(res, error.status || 500, { error: "No se pudo procesar el webhook." });
  }
}

async function runChatHandler(req, res) {
  if (req.method === "POST") {
    try {
      req.body = await readJsonBody(req);
    } catch (error) {
      return sendJson(res, error.status || 400, { error: error.message });
    }
  }

  const adapter = {
    setHeader(name, value) {
      res.setHeader(name, value);
    },
    status(code) {
      res.statusCode = code;
      return this;
    },
    json(payload) {
      if (!res.headersSent) {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify(payload));
      }
      return this;
    }
  };

  try {
    await chatHandler(req, adapter);
  } catch (error) {
    console.error("Error en el asistente local:", error.message);
    if (!res.headersSent) sendJson(res, 500, { error: "No se pudo completar la solicitud del asistente." });
  }
}

function getSessionToken(req) {
  const cookieHeader = req.headers.cookie || "";
  const entry = cookieHeader.split(";").map(value => value.trim()).find(value => value.startsWith("mmh_local_session="));
  return entry ? decodeURIComponent(entry.slice("mmh_local_session=".length)) : "";
}

function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie", `mmh_local_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "mmh_local_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
}

function passwordResetBaseUrl() {
  const configured = String(process.env.APP_BASE_URL || `http://${HOST}:${PORT}`);
  const base = new URL(configured);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname))) {
    throw Object.assign(new Error("APP_BASE_URL debe usar HTTPS."), { status: 503 });
  }
  base.pathname = "/";
  base.search = "";
  base.hash = "";
  return base.toString();
}

async function sendPasswordResetEmail(email, resetUrl) {
  const scriptUrl = String(process.env.GOOGLE_APPS_SCRIPT_URL || "").trim();
  const secret = String(process.env.PASSWORD_RESET_MAIL_SECRET || "").trim();
  const response = await fetch(scriptUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret, email, resetUrl }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Google Apps Script respondió con estado ${response.status}.`);
  const result = await response.json();
  if (!result?.ok) throw new Error("Google Apps Script no confirmó el envío del correo.");
}

async function runLocalApi(req, res, pathname) {
  const token = getSessionToken(req);
  const customer = localStore.findSession(token);
  try {
    if (pathname === "/api/local/password-reset/request" && req.method === "POST") {
      if (!String(process.env.GOOGLE_APPS_SCRIPT_URL || "").trim() || !String(process.env.PASSWORD_RESET_MAIL_SECRET || "").trim()) {
        return sendJson(res, 503, { error: "El envío de correos de recuperación todavía no está configurado. Contacta a MMH para recuperar tu cuenta." });
      }
      const { email } = await readJsonBody(req);
      const reset = localStore.issuePasswordReset(email);
      if (reset) {
        const resetUrl = `${passwordResetBaseUrl()}#reset-password=${reset.token}`;
        try {
          await sendPasswordResetEmail(reset.email, resetUrl);
        } catch (error) {
          localStore.revokePasswordReset(reset.token);
          console.error("No se pudo enviar el correo local de recuperación.", error.message);
        }
      }
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === "/api/local/password-reset/complete" && req.method === "POST") {
      localStore.resetPassword(await readJsonBody(req));
      clearSessionCookie(res);
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === "/api/local/visitor-leads" && req.method === "POST") {
      const lead = localStore.createVisitorLead(await readJsonBody(req));
      return sendJson(res, 201, { ok: true, id: lead.id });
    }
    if (pathname === "/api/local/session" && req.method === "GET") {
      return sendJson(res, 200, { customer });
    }
    if (pathname === "/api/local/register" && req.method === "POST") {
      const result = localStore.register(await readJsonBody(req));
      setSessionCookie(res, result.token);
      return sendJson(res, 201, { customer: result.customer });
    }
    if (pathname === "/api/local/login" && req.method === "POST") {
      const result = localStore.login(await readJsonBody(req));
      setSessionCookie(res, result.token);
      return sendJson(res, 200, { customer: result.customer });
    }
    if (pathname === "/api/local/logout" && req.method === "POST") {
      localStore.deleteSession(token);
      clearSessionCookie(res);
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === "/api/local/orders" && req.method === "GET") {
      if (!customer) return sendJson(res, 401, { error: "Inicia sesión para ver tus pedidos." });
      return sendJson(res, 200, { orders: localStore.listOrders(customer.email) });
    }
    if (pathname === "/api/local/orders" && req.method === "POST") {
      if (!customer) return sendJson(res, 401, { error: "Inicia sesión para registrar un pedido." });
      const order = localStore.createOrder(customer.email, await readJsonBody(req));
      return sendJson(res, 201, { order });
    }
    const paymentMatch = pathname.match(/^\/api\/local\/orders\/(MMH-[A-F0-9]{8})\/(payment-intent|payment-status)$/);
    if (paymentMatch && req.method === "POST") {
      if (!customer) return sendJson(res, 401, { error: "Inicia sesión para pagar tu pedido." });
      const result = paymentMatch[2] === "payment-intent"
        ? await startOrderPayment(customer.email, paymentMatch[1])
        : await syncOrderPayment(customer.email, paymentMatch[1]);
      return sendJson(res, 200, result);
    }
    if (pathname.startsWith("/api/local/")) {
      return sendJson(res, 404, { error: "No se encontró esa función local." });
    }
    return sendJson(res, 405, { error: "Método no permitido." }, { Allow: "GET, POST" });
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.status ? error.message : "No se pudo completar la operación local." });
  }
}

function serveFile(req, res, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestedPath);
  } catch {
    return sendJson(res, 400, { error: "La ruta no es válida." });
  }
  const pathSegments = decodedPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const firstSegment = (pathSegments[0] || "").toLowerCase();
  const privateDirectories = new Set([".git", ".vercel", "api", "data"]);
  const privateFiles = new Set(["server-local.js", "local-store.js", "confirmar-pago-local.js", "payments.js"]);
  if (pathSegments.some(segment => segment.startsWith(".")) || privateDirectories.has(firstSegment) || privateFiles.has(firstSegment)) {
    return sendJson(res, 404, { error: "No se encontró ese archivo." });
  }

  const filePath = path.resolve(ROOT, `.${decodedPath}`);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    return sendJson(res, 403, { error: "Ruta no permitida." });
  }

  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) return sendJson(res, 404, { error: "No se encontró ese archivo." });
    const contentTypes = {
      ".css": "text/css; charset=utf-8",
      ".html": "text/html; charset=utf-8",
      ".ico": "image/x-icon",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".webmanifest": "application/manifest+json; charset=utf-8",
      ".webp": "image/webp"
    };
    const headers = {
      "Content-Type": contentTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff"
    };
    if (["index.html", "sw.js", "manifest.webmanifest"].includes(path.basename(filePath))) {
      headers["Cache-Control"] = "no-cache";
    }
    res.writeHead(200, headers);
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname === "/api/chat") return runChatHandler(req, res);
  if (url.pathname === "/api/stripe/webhook" && req.method === "POST") return runStripeWebhook(req, res);
  if (url.pathname.startsWith("/api/local/")) return runLocalApi(req, res, url.pathname);
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, { error: "Este servidor local solo admite solicitudes de lectura." }, { Allow: "GET, HEAD" });
  }
  serveFile(req, res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`MMH Builds está disponible en http://${HOST}:${PORT}`);
  console.log("Presiona Ctrl+C para cerrar el servidor local.");
  if (!process.env.GEMINI_API_KEY) {
    console.log("El asistente de IA necesita GEMINI_API_KEY en .env.local para responder.");
  }
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
