function doPost(event) {
  try {
    const payload = JSON.parse(event && event.postData && event.postData.contents || "{}");
    const expectedSecret = PropertiesService.getScriptProperties().getProperty("MMH_RESET_MAIL_SECRET") || "";
    if (!constantTimeEqual_(String(payload.secret || ""), expectedSecret) || expectedSecret.length < 32) {
      console.warn("MMH_RESET: solicitud rechazada; la clave compartida no coincide o falta.");
      return jsonResponse_({ ok: false });
    }

    const email = String(payload.email || "").trim().toLowerCase();
    const resetUrl = String(payload.resetUrl || "");
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
    const validResetUrl = /^(https:\/\/mmh-builds\.pages\.dev|http:\/\/127\.0\.0\.1:4173)\/#reset-password=[a-f0-9]{64}$/.test(resetUrl);
    if (!validEmail || !validResetUrl) {
      console.warn("MMH_RESET: solicitud rechazada; el correo o el enlace no tiene el formato esperado.");
      return jsonResponse_({ ok: false });
    }

    if (MailApp.getRemainingDailyQuota() < 1) {
      console.warn("MMH_RESET: solicitud rechazada; Google informa que no queda cuota diaria de correo.");
      return jsonResponse_({ ok: false });
    }

    MailApp.sendEmail({
      to: email,
      subject: "Recupera tu contraseña de MMH Builds",
      body: `Recibimos una solicitud para cambiar la contraseña de tu cuenta MMH Builds. Abre este enlace en los próximos 30 minutos para elegir una contraseña nueva:\n\n${resetUrl}\n\nSi no solicitaste este cambio, ignora este mensaje. Tu contraseña actual seguirá funcionando.`,
      htmlBody: `<div style="margin:0;background:#0b0818;padding:32px 16px;color:#f5f1ff;font-family:Arial,sans-serif"><div style="max-width:520px;margin:auto;padding:28px;border:1px solid #38274e;border-radius:18px;background:#171329"><p style="color:#ff65c9;font-weight:700;letter-spacing:.14em">MMH BUILDS</p><h1 style="font-size:24px">Recupera tu contraseña</h1><p style="color:#c4bdd1;line-height:1.6">Solicitaste cambiar la contraseña de tu cuenta. Este enlace se puede usar una sola vez y vence en 30 minutos.</p><p style="margin:28px 0"><a href="${resetUrl}" style="padding:13px 18px;border-radius:10px;background:#d45be6;color:#160d22;font-weight:700;text-decoration:none">Crear contraseña nueva</a></p><p style="color:#aaa2b8;font-size:13px;line-height:1.6">Si no solicitaste el cambio, ignora este correo. Tu contraseña actual seguirá funcionando.</p></div></div>`,
      name: "MMH Builds"
    });
    console.log("MMH_RESET: correo aceptado para envío por MailApp.");
    return jsonResponse_({ ok: true });
  } catch (error) {
    console.error("MMH_RESET: error al procesar la solicitud.", error && error.name || "Error");
    return jsonResponse_({ ok: false });
  }
}

function authorizeMailSender() {
  MailApp.getRemainingDailyQuota();
}

function constantTimeEqual_(left, right) {
  if (!right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
function doPost(event) {
  try {
    const payload = JSON.parse(event && event.postData && event.postData.contents || "{}");
    const expectedSecret = PropertiesService.getScriptProperties().getProperty("MMH_RESET_MAIL_SECRET") || "";
    if (!constantTimeEqual_(String(payload.secret || ""), expectedSecret) || expectedSecret.length < 32) {
      console.warn("MMH_RESET: solicitud rechazada; la clave compartida no coincide o falta.");
      return jsonResponse_({ ok: false });
    }

    const email = String(payload.email || "").trim().toLowerCase();
    const resetUrl = String(payload.resetUrl || "");
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
    const validResetUrl = /^(https:\/\/mmh-builds\.pages\.dev|http:\/\/127\.0\.0\.1:4173)\/#reset-password=[a-f0-9]{64}$/.test(resetUrl);
    if (!validEmail || !validResetUrl) {
      console.warn("MMH_RESET: solicitud rechazada; el correo o el enlace no tiene el formato esperado.");
      return jsonResponse_({ ok: false });
    }

    if (MailApp.getRemainingDailyQuota() < 1) {
      console.warn("MMH_RESET: solicitud rechazada; Google informa que no queda cuota diaria de correo.");
      return jsonResponse_({ ok: false });
    }

    MailApp.sendEmail({
      to: email,
      subject: "Recupera tu contraseña de MMH Builds",
      body: `Recibimos una solicitud para cambiar la contraseña de tu cuenta MMH Builds. Abre este enlace en los próximos 30 minutos para elegir una contraseña nueva:\n\n${resetUrl}\n\nSi no solicitaste este cambio, ignora este mensaje. Tu contraseña actual seguirá funcionando.`,
      htmlBody: `<div style="margin:0;background:#0b0818;padding:32px 16px;color:#f5f1ff;font-family:Arial,sans-serif"><div style="max-width:520px;margin:auto;padding:28px;border:1px solid #38274e;border-radius:18px;background:#171329"><p style="color:#ff65c9;font-weight:700;letter-spacing:.14em">MMH BUILDS</p><h1 style="font-size:24px">Recupera tu contraseña</h1><p style="color:#c4bdd1;line-height:1.6">Solicitaste cambiar la contraseña de tu cuenta. Este enlace se puede usar una sola vez y vence en 30 minutos.</p><p style="margin:28px 0"><a href="${resetUrl}" style="padding:13px 18px;border-radius:10px;background:#d45be6;color:#160d22;font-weight:700;text-decoration:none">Crear contraseña nueva</a></p><p style="color:#aaa2b8;font-size:13px;line-height:1.6">Si no solicitaste el cambio, ignora este correo. Tu contraseña actual seguirá funcionando.</p></div></div>`,
      name: "MMH Builds"
    });
    console.log("MMH_RESET: correo aceptado para envío por MailApp.");
    return jsonResponse_({ ok: true });
  } catch (error) {
    console.error("MMH_RESET: error al procesar la solicitud.", error && error.name || "Error");
    return jsonResponse_({ ok: false });
  }
}

function authorizeMailSender() {
  MailApp.getRemainingDailyQuota();
}

function constantTimeEqual_(left, right) {
  if (!right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
