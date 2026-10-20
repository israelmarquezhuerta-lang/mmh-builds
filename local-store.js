const { createHash, randomBytes, scryptSync, timingSafeEqual } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { calculateLoyalty } = require("./loyalty");
const { priceOrderItems } = require("./catalog");

const dataDirectory = path.join(__dirname, "data");
fs.mkdirSync(dataDirectory, { recursive: true });
const database = new DatabaseSync(path.join(dataDirectory, "mmh-local.sqlite"));
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS customers (
    email TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    address TEXT NOT NULL,
    salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL REFERENCES customers(email) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_by_email ON sessions(email);
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL REFERENCES customers(email) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS password_reset_tokens_by_email ON password_reset_tokens(email);
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL REFERENCES customers(email),
    subtotal REAL NOT NULL DEFAULT 0,
    discount_rate REAL NOT NULL DEFAULT 0,
    discount_amount REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL,
    payment TEXT NOT NULL,
    payment_status TEXT NOT NULL,
    quote_required INTEGER NOT NULL,
    customer_json TEXT NOT NULL,
    items_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    stage INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS orders_by_customer ON orders(email, created_at);
  CREATE TABLE IF NOT EXISTS visitor_leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

function ensureOrderColumn(name, definition) {
  const columns = database.prepare("PRAGMA table_info(orders)").all();
  if (!columns.some(column => column.name === name)) {
    database.exec(`ALTER TABLE orders ADD COLUMN ${name} ${definition}`);
    return true;
  }
  return false;
}

if (ensureOrderColumn("subtotal", "REAL NOT NULL DEFAULT 0")) {
  database.exec("UPDATE orders SET subtotal = total WHERE subtotal = 0 AND total > 0");
}
ensureOrderColumn("discount_rate", "REAL NOT NULL DEFAULT 0");
ensureOrderColumn("discount_amount", "REAL NOT NULL DEFAULT 0");

const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function customerFromRow(row) {
  return row ? { name: row.name, email: row.email, phone: row.phone, address: row.address } : null;
}

function createSession(email) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + sessionLifetimeMs;
  database.prepare("INSERT INTO sessions (token_hash, email, expires_at) VALUES (?, ?, ?)")
    .run(createHash("sha256").update(token).digest("hex"), email, expiresAt);
  return token;
}

function register({ name, email: rawEmail, phone, address, password }) {
  const normalizedEmail = normalizeEmail(rawEmail);
  const cleanName = String(name || "").trim();
  const cleanPhone = String(phone || "").trim();
  const cleanAddress = String(address || "").trim();
  const cleanPassword = String(password || "");
  if (!cleanName || !emailPattern.test(normalizedEmail) || !cleanPhone || !cleanAddress || cleanPassword.length < 8) {
    throw Object.assign(new Error("Completa tus datos y usa una contraseña de al menos 8 caracteres."), { status: 400 });
  }
  if (database.prepare("SELECT 1 FROM customers WHERE email = ?").get(normalizedEmail)) {
    throw Object.assign(new Error("Ya existe una cuenta con ese correo. Inicia sesión."), { status: 409 });
  }

  const salt = randomBytes(16).toString("hex");
  const passwordHash = scryptSync(cleanPassword, salt, 64).toString("hex");
  database.prepare(`INSERT INTO customers (email, name, phone, address, salt, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(normalizedEmail, cleanName, cleanPhone, cleanAddress, salt, passwordHash, new Date().toISOString());
  const customer = customerFromRow(database.prepare("SELECT * FROM customers WHERE email = ?").get(normalizedEmail));
  return { customer, token: createSession(normalizedEmail) };
}

function createVisitorLead({ name: rawName, phone: rawPhone }) {
  const name = String(rawName || "").trim().replace(/\s+/g, " ").slice(0, 100);
  const phone = String(rawPhone || "").trim().slice(0, 20);
  const phoneDigits = phone.replace(/\D/g, "");
  if (name.length < 2 || !/^[\p{L}\p{M} .'-]+$/u.test(name) || phoneDigits.length < 10 || phoneDigits.length > 15 || !/^[0-9+() .-]+$/.test(phone)) {
    throw Object.assign(new Error("Escribe un nombre y un teléfono válidos (10 a 15 dígitos)."), { status: 400 });
  }
  const createdAt = new Date().toISOString();
  const result = database.prepare("INSERT INTO visitor_leads (name, phone, created_at) VALUES (?, ?, ?)").run(name, phone, createdAt);
  return { id: Number(result.lastInsertRowid), name, phone, createdAt };
}

function login({ email: rawEmail, password }) {
  const email = normalizeEmail(rawEmail);
  const row = database.prepare("SELECT * FROM customers WHERE email = ?").get(email);
  const supplied = scryptSync(String(password || ""), row ? row.salt : "00000000000000000000000000000000", 64);
  const expected = Buffer.from(row?.password_hash || "0".repeat(128), "hex");
  if (!row || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw Object.assign(new Error("Correo o contraseña incorrectos."), { status: 401 });
  }
  return { customer: customerFromRow(row), token: createSession(email) };
}

function issuePasswordReset(rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!emailPattern.test(email) || email.length > 254) {
    throw Object.assign(new Error("Escribe un correo electrónico válido."), { status: 400 });
  }
  const customer = database.prepare("SELECT email FROM customers WHERE email = ?").get(email);
  if (!customer) return null;

  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const now = Date.now();
  database.prepare("DELETE FROM password_reset_tokens WHERE expires_at <= ? OR email = ?").run(now, email);
  database.prepare(`INSERT INTO password_reset_tokens (token_hash, email, expires_at, created_at)
    VALUES (?, ?, ?, ?)`)
    .run(tokenHash, email, now + 30 * 60 * 1000, new Date(now).toISOString());
  return { email, token };
}

function revokePasswordReset(token) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ""))) return;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  database.prepare("DELETE FROM password_reset_tokens WHERE token_hash = ?").run(tokenHash);
}

function resetPassword({ token, password }) {
  const cleanToken = String(token || "");
  const cleanPassword = String(password || "");
  if (!/^[a-f0-9]{64}$/.test(cleanToken) || cleanPassword.length < 8 || cleanPassword.length > 256) {
    throw Object.assign(new Error("El enlace no es válido o ya venció. Solicita uno nuevo."), { status: 400 });
  }
  const tokenHash = createHash("sha256").update(cleanToken).digest("hex");
  const now = Date.now();

  database.exec("BEGIN IMMEDIATE");
  try {
    const reset = database.prepare("SELECT email FROM password_reset_tokens WHERE token_hash = ? AND expires_at > ?")
      .get(tokenHash, now);
    if (!reset) throw Object.assign(new Error("El enlace no es válido o ya venció. Solicita uno nuevo."), { status: 400 });
    const salt = randomBytes(16).toString("hex");
    const passwordHash = scryptSync(cleanPassword, salt, 64).toString("hex");
    database.prepare("UPDATE customers SET salt = ?, password_hash = ? WHERE email = ?")
      .run(salt, passwordHash, reset.email);
    database.prepare("DELETE FROM sessions WHERE email = ?").run(reset.email);
    database.prepare("DELETE FROM password_reset_tokens WHERE email = ?").run(reset.email);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function findSession(token) {
  if (!token) return null;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const row = database.prepare(`SELECT customers.* FROM sessions
    JOIN customers ON customers.email = sessions.email
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?`).get(tokenHash, Date.now());
  return customerFromRow(row);
}

function deleteSession(token) {
  if (!token) return;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

function getCustomerLoyalty(email) {
  const verifiedOrders = database.prepare(`SELECT subtotal, total, payment_status FROM orders
    WHERE email = ? AND payment_status = ?`).all(email, "Pago verificado");
  return calculateLoyalty(verifiedOrders);
}

function createOrder(email, input) {
  const priced = priceOrderItems(input.items);
  if (!priced) {
    throw Object.assign(new Error("El pedido no contiene artículos válidos."), { status: 400 });
  }
  const customer = {
    name: String(input.customer?.name || "").trim(),
    email,
    phone: String(input.customer?.phone || "").trim(),
    address: String(input.customer?.address || "").trim()
  };
  if (!customer.name || !customer.phone || !customer.address) {
    throw Object.assign(new Error("Revisa los datos del pedido y vuelve a intentar."), { status: 400 });
  }

  const { items, subtotal, quoteRequired } = priced;
  const loyalty = getCustomerLoyalty(email);
  const discountRate = loyalty.discountPercent;
  const discountAmount = Math.round(subtotal * discountRate) / 100;
  const order = {
    id: `MMH-${randomBytes(4).toString("hex").toUpperCase()}`,
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
  database.prepare("UPDATE customers SET name = ?, phone = ?, address = ? WHERE email = ?")
    .run(customer.name, customer.phone, customer.address, email);
  database.prepare(`INSERT INTO orders (id, email, subtotal, discount_rate, discount_amount, total,
    payment, payment_status, quote_required, customer_json, items_json, created_at, stage)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(order.id, email, order.subtotal, order.discountRate, order.discountAmount, order.total,
      order.payment, order.paymentStatus, Number(order.quoteRequired),
      JSON.stringify(order.customer), JSON.stringify(order.items), order.createdAt, order.stage);
  return order;
}

function listOrders(email) {
  return database.prepare("SELECT * FROM orders WHERE email = ? ORDER BY created_at ASC").all(email).map(row => ({
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

function verifyOrderPayment(id) {
  const order = database.prepare("SELECT email, payment_status, quote_required FROM orders WHERE id = ?").get(id);
  if (!order) {
    throw Object.assign(new Error("No se encontró esa solicitud."), { status: 404 });
  }
  if (order.quote_required) {
    throw Object.assign(new Error("Las solicitudes con servicios requieren una cotización y un total final antes de confirmar el pago."), { status: 409 });
  }
  if (order.payment_status === "Pago verificado") {
    throw Object.assign(new Error("El pago de esta solicitud ya fue verificado."), { status: 409 });
  }
  database.prepare("UPDATE orders SET payment_status = ? WHERE id = ?")
    .run("Pago verificado", id);
  return listOrders(order.email).find(item => item.id === id);
}

module.exports = { createOrder, createVisitorLead, deleteSession, findSession, getCustomerLoyalty, issuePasswordReset, listOrders, login, register, resetPassword, revokePasswordReset, verifyOrderPayment };
