const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const localStore = require("./local-store");

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

async function runLocalApi(req, res, pathname) {
  const token = getSessionToken(req);
  const customer = localStore.findSession(token);
  try {
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
    const orderMatch = pathname.match(/^\/api\/local\/orders\/([A-Za-z0-9-]+)$/);
    if (orderMatch && req.method === "PATCH") {
      if (!customer) return sendJson(res, 401, { error: "Inicia sesión para actualizar el pedido." });
      const body = await readJsonBody(req);
      const order = localStore.updateOrderStage(customer.email, orderMatch[1], body.stage);
      if (!order) return sendJson(res, 404, { error: "No se encontró ese pedido." });
      return sendJson(res, 200, { order });
    }
    if (pathname.startsWith("/api/local/")) {
      return sendJson(res, 404, { error: "No se encontró esa función local." });
    }
    return sendJson(res, 405, { error: "Método no permitido." }, { Allow: "GET, POST, PATCH" });
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
  const privateFiles = new Set(["server-local.js", "local-store.js", "confirmar-pago-local.js"]);
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
