(function (root, factory) {
  const payments = factory();
  if (typeof module === "object" && module.exports) module.exports = payments;
  else root.MmhPayments = payments;
})(globalThis, function () {
  const stripeApi = "https://api.stripe.com/v1";
  const currency = "mxn";
  const paidStatus = "Pago verificado";
  const unpaidStatus = "Pendiente de pago";
  const webhookToleranceSeconds = 300;

  const isConfigured = env => /^sk_(test|live)_/.test(String(env.STRIPE_SECRET_KEY || "")) &&
    /^pk_(test|live)_/.test(String(env.STRIPE_PUBLISHABLE_KEY || ""));

  const amountInCents = total => Math.round(Number(total) * 100);

  function formEncode(params, prefix = "") {
    const pairs = [];
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      const name = prefix ? `${prefix}[${key}]` : key;
      if (typeof value === "object") pairs.push(formEncode(value, name));
      else pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    }
    return pairs.filter(Boolean).join("&");
  }

  async function stripeRequest(secretKey, method, path, params, idempotencyKey) {
    const headers = { Authorization: `Bearer ${secretKey}`, "Stripe-Version": "2024-06-20" };
    if (params) headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    let response;
    try {
      response = await fetch(`${stripeApi}${path}`, { method, headers, body: params ? formEncode(params) : undefined });
    } catch {
      throw Object.assign(new Error("No pudimos conectar con el procesador de pagos. Intenta de nuevo."), { status: 502 });
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("Error de Stripe:", payload.error?.type, payload.error?.code);
      throw Object.assign(new Error("El procesador de pagos no aceptó la solicitud. Intenta de nuevo más tarde."), { status: 502 });
    }
    return payload;
  }

  async function ensureCustomer(secretKey, existingId, customer) {
    if (existingId) return existingId;
    const created = await stripeRequest(secretKey, "POST", "/customers", {
      email: customer.email,
      name: customer.name,
      phone: customer.phone
    }, `customer-${customer.email}`);
    return created.id;
  }

  async function createOrReusePaymentIntent(secretKey, { order, stripeCustomerId }) {
    const amount = amountInCents(order.total);
    if (order.paymentIntentId) {
      const existing = await stripeRequest(secretKey, "GET", `/payment_intents/${encodeURIComponent(order.paymentIntentId)}`);
      if (existing.amount === amount && !["succeeded", "canceled"].includes(existing.status)) return existing;
      if (existing.status === "succeeded") return existing;
    }
    return stripeRequest(secretKey, "POST", "/payment_intents", {
      amount,
      currency,
      customer: stripeCustomerId,
      description: `Pedido ${order.id} · MMH Builds`,
      receipt_email: order.customer.email,
      payment_method_types: ["card"],
      payment_method_options: { card: { request_three_d_secure: "any" } },
      metadata: { order_id: order.id, customer_email: order.customer.email }
    }, `payment-intent-${order.id}-${amount}`);
  }

  function retrievePaymentIntent(secretKey, id) {
    return stripeRequest(secretKey, "GET", `/payment_intents/${encodeURIComponent(id)}`);
  }

  function paymentMatchesOrder(intent, order) {
    return intent && intent.status === "succeeded" &&
      intent.currency === currency &&
      intent.amount_received === amountInCents(order.total) &&
      intent.metadata?.order_id === order.id;
  }

  function hexFromBuffer(buffer) {
    return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }

  async function verifyWebhook(rawBody, signatureHeader, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
    if (!secret || !signatureHeader) return null;
    const parts = String(signatureHeader).split(",").map(part => part.split("="));
    const timestamp = Number(parts.find(([key]) => key === "t")?.[1]);
    const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
    if (!timestamp || !signatures.length || Math.abs(nowSeconds - timestamp) > webhookToleranceSeconds) return null;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const expected = hexFromBuffer(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${rawBody}`)));
    const matches = signatures.some(signature => {
      if (signature.length !== expected.length) return false;
      let difference = 0;
      for (let index = 0; index < expected.length; index += 1) difference |= signature.charCodeAt(index) ^ expected.charCodeAt(index);
      return difference === 0;
    });
    if (!matches) return null;
    try {
      return JSON.parse(rawBody);
    } catch {
      return null;
    }
  }

  return {
    currency,
    paidStatus,
    unpaidStatus,
    isConfigured,
    amountInCents,
    ensureCustomer,
    createOrReusePaymentIntent,
    retrievePaymentIntent,
    paymentMatchesOrder,
    verifyWebhook
  };
});
