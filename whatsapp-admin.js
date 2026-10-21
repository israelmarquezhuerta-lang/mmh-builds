/* Private conversation data stays in memory. No localStorage, IndexedDB or offline cache. */
(() => {
  const base = '/api/local/admin/whatsapp';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const date = value => new Date(value).toLocaleString('es-MX');
  const statuses = { received: 'Recibido', sending: 'Envío en proceso; no repetir', accepted: 'Aceptado por Meta', sent: 'Enviado', delivered: 'Entregado', read: 'Leído', failed: 'Rechazado por Meta', unknown: 'Resultado incierto; revisar antes de reenviar' };
  let renderedMessages = [];
  let root, identity = '', generation = 0, active = '', conversation = null, page = 0, more = false, busy = false, messageBusy = false, mutationBusy = false, previousAttention = null, previousRevision = null, oldest = 0, hasOlder = false, pendingSend = null, blockedIdentity = '';
  const drafts = new Map();
  const pendingRequests = new Map();
  async function api(path = '', options = {}) {
    const response = await fetch(base + path, { credentials: 'same-origin', cache: 'no-store', ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(data.error || 'No se pudo cargar el Centro de Mensajes.'); error.status = response.status; throw error; }
    return data;
  }
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
  function clear() {
    generation++; renderedMessages = []; active = ''; conversation = null; identity = ''; previousAttention = null; previousRevision = null; pendingSend = null; drafts.clear(); pendingRequests.clear();
    root.hidden = true; root.querySelector('[data-wa-list]').replaceChildren(); root.querySelector('[data-wa-messages]').replaceChildren(); root.querySelector('textarea').value = ''; root.querySelector('[data-wa-detail]').hidden = true; root.querySelector('[data-wa-status]').textContent = '';
    for (const selector of ['[data-wa-client]', '[data-wa-window]', '[data-wa-mode]', '[data-wa-count]']) root.querySelector(selector).textContent = '';
  }
  function errorText(error) {
    root.querySelector('[data-wa-status]').textContent = error.message;
    if (error.status === 401 || error.status === 403) { blockedIdentity = identity; clear(); }
  }
  function filters() { return `?page=${page}&interest=${encodeURIComponent(root.querySelector('[data-wa-interest]').value)}&attention=${root.querySelector('[data-wa-attention]').checked ? 1 : 0}`; }
  function controls() {
    if (!conversation) return;
    const open = conversation.window_expires_at > Date.now();
    root.querySelector('[data-wa-client]').textContent = `${conversation.name || 'Cliente'} · +${conversation.wa_id}`;
    root.querySelector('[data-wa-mode]').textContent = conversation.mode === 'manual' ? 'Gemini pausado en esta conversación' : conversation.needs_attention ? 'Gemini en espera de revisión' : 'Gemini activo';
    root.querySelector('[data-wa-window]').textContent = open ? `Puedes responder hasta ${date(conversation.window_expires_at)}` : 'Ventana de 24 horas cerrada. Espera un nuevo mensaje del cliente.';
    root.querySelector('[data-wa-take]').hidden = conversation.mode === 'manual'; root.querySelector('[data-wa-resume]').hidden = conversation.mode !== 'manual';
    root.querySelector('[data-wa-send]').disabled = mutationBusy || conversation.mode !== 'manual' || !open;
    root.querySelector('textarea').disabled = mutationBusy || conversation.mode !== 'manual' || !open;
    for (const button of root.querySelectorAll('[data-wa-take],[data-wa-resume],[data-wa-resolve]')) button.disabled = mutationBusy;
  }
  function renderMessage(m) {
    return `<article class="wa-message wa-${esc(m.direction)}"><small>${esc(m.sender === 'customer' ? 'Cliente' : m.sender === 'admin' ? 'Tú · atención manual' : 'Gemini')} · ${esc(date(m.created_at))}</small><p>${esc(m.body)}</p><small>${esc(statuses[m.status] || m.status)}${m.error_code ? ' · Código ' + esc(m.error_code) : ''}</small></article>`;
  }
  async function loadMessages(older = false) {
    if (!active || messageBusy || mutationBusy) return; messageBusy = true;
    const id = active; const gen = generation;
    try {
      const data = await api(`/${encodeURIComponent(id)}/messages${older && oldest ? '?before=' + oldest : ''}`);
      if (id !== active || gen !== generation) return;
      conversation = data.conversation; controls();
      const box = root.querySelector('[data-wa-messages]'); const nearEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 70; const oldHeight = box.scrollHeight;
      const merged = new Map(renderedMessages.map(m => [m.id, m]));
      for (const message of data.messages) merged.set(message.id, message);
      renderedMessages = [...merged.values()].sort((a,b) => a.id - b.id);
      box.innerHTML = renderedMessages.map(renderMessage).join('');
      oldest = renderedMessages[0]?.id || 0;
      if (older || renderedMessages.length <= 100) hasOlder = data.more;
      root.querySelector('[data-wa-older]').hidden = !hasOlder;
      if (older) box.scrollTop += box.scrollHeight - oldHeight; else if (nearEnd) box.scrollTop = box.scrollHeight;
      const last = data.messages.at(-1)?.id;
      if (!older && last && !document.hidden) await post(`/${encodeURIComponent(id)}/read`, { through: last });
    } catch (e) { if (gen === generation) errorText(e); } finally { messageBusy = false; }
  }
  async function refresh() {
    const email = typeof currentCustomer !== 'undefined' ? currentCustomer?.email || '' : '';
    if (!email) { if (identity) clear(); blockedIdentity = ''; return; }
    if (identity !== email) { clear(); identity = email; page = 0; }
    if (busy || blockedIdentity === email) return;
    busy = true; const gen = generation;
    try {
      const data = await api(filters()); if (gen !== generation) return;
      root.hidden = false; more = data.more;
      root.querySelector('[data-wa-count]').textContent = `${data.attention} conversación(es) por revisar`;
      if (previousAttention !== null && data.attention > 0 && (data.attention > previousAttention || (previousRevision !== null && data.revision > previousRevision)) && 'Notification' in window && Notification.permission === 'granted') {
        try {
          const registration = await navigator.serviceWorker?.getRegistration();
          const options = { body: 'Hay conversaciones de WhatsApp por revisar.', tag: 'mmh-whatsapp' };
          if (registration) await registration.showNotification('MMH Builds', options);
          else new Notification('MMH Builds', options);
        } catch { /* The in-page review counter remains available on unsupported browsers. */ }
      }
      if (gen !== generation) return;
      previousAttention = data.attention; previousRevision = data.revision;
      root.querySelector('[data-wa-list]').innerHTML = data.conversations.length ? data.conversations.map(c => `<button type="button" class="wa-conversation${active === c.id ? ' selected' : ''}" data-wa-select="${esc(c.id)}"><strong>${esc(c.name || '+' + c.wa_id)}</strong><span>+${esc(c.wa_id)} · ${esc({ pc: 'PCs', web: 'Página web', app: 'Aplicación', other: 'General' }[c.interest])}</span><small>${c.unread ? esc(c.unread) + ' sin leer · ' : ''}${c.needs_attention ? 'Necesita atención · ' : ''}${c.mode === 'manual' ? 'Gemini pausado' : 'Gemini activo'}</small></button>`).join('') : '<p>No hay conversaciones en este filtro. El historial comienza al activar el registro.</p>';
      root.querySelector('[data-wa-prev]').disabled = !page; root.querySelector('[data-wa-next]').disabled = !more;
      root.querySelector('[data-wa-status]').textContent = 'Actualizado ' + new Date().toLocaleTimeString('es-MX');
      await loadMessages();
    } catch (e) { if (gen === generation) { if (e.status === 503 && root.hidden) blockedIdentity = email; else errorText(e); } }
    finally { busy = false; }
  }
  async function action(kind) {
    if (!active || mutationBusy) return;
    const id = active; const gen = generation; mutationBusy = true; controls();
    try {
      await post(`/${encodeURIComponent(id)}/${kind === 'resolve' ? 'resolve' : 'mode'}`, kind === 'resolve' ? {} : { mode: kind });
    } catch (e) { if (gen === generation) errorText(e); }
    finally { mutationBusy = false; controls(); await loadMessages(); }
  }
  function init() {
    root = document.createElement('section'); root.id = 'whatsapp-center'; root.className = 'wa-center shell'; root.hidden = true;
    root.innerHTML = `<div class="store-heading"><div><span class="eyebrow">ADMINISTRACIÓN PRIVADA</span><h2>Centro de Mensajes · WhatsApp</h2><p data-wa-count></p></div><button type="button" class="button secondary" data-wa-notify>Activar avisos del navegador</button></div><p class="cart-note">Se actualiza cada 10 segundos. Los avisos funcionan mientras esta página permanece abierta. Audios e imágenes se señalan para atención; su contenido multimedia no se descarga.</p><div class="wa-toolbar"><label>Interés<select data-wa-interest><option value="">Todos</option><option value="pc">PCs</option><option value="web">Páginas web</option><option value="app">Aplicaciones</option><option value="other">General</option></select></label><label><input type="checkbox" data-wa-attention> Necesitan atención</label><button type="button" class="button secondary" data-wa-refresh>Actualizar</button></div><p data-wa-status role="status" aria-live="polite"></p><div class="wa-layout"><aside><div data-wa-list></div><div class="wa-toolbar"><button type="button" data-wa-prev>Anterior</button><button type="button" data-wa-next>Siguiente</button></div></aside><div data-wa-detail hidden><h3 data-wa-client></h3><p data-wa-mode></p><div class="wa-toolbar"><button type="button" class="button" data-wa-take>Atender y pausar Gemini</button><button type="button" class="button" data-wa-resume>Terminar y reactivar Gemini</button><button type="button" class="button secondary" data-wa-resolve>Marcar revisada</button></div><button type="button" data-wa-older hidden>Ver mensajes anteriores</button><div class="wa-messages" data-wa-messages aria-label="Mensajes"></div><p data-wa-window></p><form data-wa-compose><label>Tu respuesta<textarea rows="4" maxlength="4096" required placeholder="Toma la conversación para responder"></textarea></label><button type="submit" class="button" data-wa-send disabled>Enviar por WhatsApp</button></form></div></div>`;
    document.querySelector('main').append(root);
    root.addEventListener('click', async event => {
      const button = event.target.closest('button'); if (!button) return;
      if (button.hasAttribute('data-wa-select')) {
        if (mutationBusy || messageBusy) return;
        if (active) drafts.set(active, root.querySelector('textarea').value);
        active = button.dataset.waSelect; renderedMessages = []; hasOlder = false; pendingSend = pendingRequests.get(active) || null; conversation = null;
        root.querySelector('[data-wa-detail]').hidden = false; root.querySelector('[data-wa-messages]').replaceChildren();
        root.querySelector('textarea').value = drafts.get(active) || ''; root.querySelector('textarea').disabled = true; root.querySelector('[data-wa-send]').disabled = true;
        await loadMessages(); return;
      }
      if (button.hasAttribute('data-wa-take')) return action('manual');
      if (button.hasAttribute('data-wa-resume')) return action('bot');
      if (button.hasAttribute('data-wa-resolve')) return action('resolve');
      if (button.hasAttribute('data-wa-older')) return loadMessages(true);
      if (button.hasAttribute('data-wa-next')) page++;
      if (button.hasAttribute('data-wa-prev')) page = Math.max(0, page - 1);
      if (button.hasAttribute('data-wa-notify')) {
        if (!('Notification' in window)) { root.querySelector('[data-wa-status]').textContent = 'Este navegador no admite avisos. Revisa el contador del panel.'; return; }
        await Notification.requestPermission(); return;
      }
      if (button.matches('[data-wa-next],[data-wa-prev],[data-wa-refresh]')) refresh();
    });
    for (const field of root.querySelectorAll('[data-wa-interest],[data-wa-attention]')) field.addEventListener('change', () => { page = 0; refresh(); });
    root.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault(); if (!active || !conversation || mutationBusy) return;
      const input = root.querySelector('textarea'); const text = input.value.trim(); if (!text) return;
      const id = active; const gen = generation;
      if (!pendingSend || pendingSend.id !== id || pendingSend.text !== text) pendingSend = { id, text, key: crypto.randomUUID() };
      pendingRequests.set(id, pendingSend);
      mutationBusy = true; controls();
      try {
        const data = await post(`/${encodeURIComponent(id)}/messages`, { text, key: pendingSend.key });
        if (gen !== generation) return;
        if (['accepted','sent','delivered','read'].includes(data.message.status)) { input.value = ''; drafts.delete(id); pendingRequests.delete(id); pendingSend = null; }
        else root.querySelector('[data-wa-status]').textContent = statuses[data.message.status] || 'Revisa el estado del envío antes de repetirlo.';
      } catch (e) { if (gen === generation) errorText(e); }
      finally { mutationBusy = false; controls(); await loadMessages(); }
    });
    new MutationObserver(() => {
      const email = typeof currentCustomer !== 'undefined' ? currentCustomer?.email || '' : '';
      if (email !== identity) refresh();
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    setInterval(refresh, 10_000); document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); }); refresh();
  }
  if (document.readyState === 'complete') init(); else window.addEventListener('load', init, { once: true });
})();
