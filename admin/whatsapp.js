const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const date=value=>value?new Date(value).toLocaleString('es-MX'):'—';
let selectedPhone='';
async function api(query='') {
  const r=await fetch('/api/whatsapp-inbox'+query,{cache:'no-store',credentials:'same-origin'});
  const body=await r.json();
  if(!r.ok) {if(r.status===401)$('inbox-login').classList.remove('hide');throw Error(body.error||'No se pudo consultar WhatsApp.');}
  $('inbox-login').classList.add('hide');return body;
}
function filterThreads(){const term=$('client-search').value.trim().toLowerCase();document.querySelectorAll('[data-phone]').forEach(b=>b.hidden=!b.textContent.toLowerCase().includes(term));}
async function loadThreads(){
  try{
    const {conversations=[]}=await api();
    $('count').textContent=`${conversations.length} clientes`;
    $('threads').innerHTML=conversations.length?conversations.map(item=>`<button class="thread ${item.phone===selectedPhone?'active':''}" data-phone="${esc(item.phone)}"><span class="thread-top"><span>${esc(item.contactName||item.phone)}</span><span class="tag">${esc(item.messageCount)}</span></span><span class="thread-preview">${item.lastDirection==='outbound'?'MMH: ':''}${esc(item.lastMessage)}</span><span class="thread-meta"><span>${esc(item.phone)}</span><time>${esc(date(item.lastMessageAt))}</time></span></button>`).join(''):'<div class="empty">Aún no hay mensajes guardados. Los nuevos mensajes del número empresarial aparecerán aquí.</div>';
    filterThreads();if(selectedPhone)await openThread(selectedPhone);
  }catch(error){$('threads').innerHTML=`<div class="error">${esc(error.message)}</div>`;}
}
async function openThread(phone){
  try{
    const {messages=[]}=await api('?phone='+encodeURIComponent(phone));selectedPhone=phone;
    $('thread-title').textContent=messages.at(-1)?.contactName||phone;
    $('messages').innerHTML=messages.length?messages.map(item=>`<article class="message ${item.direction==='outbound'?'outbound':''}"><small>${item.direction==='outbound'?'MMH Builds · respuesta automática':'Cliente'} · ${esc(date(item.createdAt))}${item.direction==='outbound'?' · '+esc(item.status):''}</small>${esc(item.body)}</article>`).join(''):'<div class="empty">No hay mensajes en esta conversación.</div>';
    $('messages').scrollTop=$('messages').scrollHeight;
    document.querySelectorAll('[data-phone]').forEach(b=>b.classList.toggle('active',b.dataset.phone===phone));
  }catch(error){$('messages').innerHTML=`<div class="error">${esc(error.message)}</div>`;}
}
$('threads').addEventListener('click',event=>{const b=event.target.closest('[data-phone]');if(b)void openThread(b.dataset.phone);});
$('refresh').addEventListener('click',()=>void loadThreads());
$('client-search').addEventListener('input',filterThreads);
$('inbox-login').addEventListener('submit',async event=>{
  event.preventDefault();const form=event.currentTarget,submit=form.querySelector('button');submit.disabled=true;
  try{
    const r=await fetch('/api/local/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:form.elements.email.value,password:form.elements.password.value})});
    const body=await r.json();if(!r.ok)throw Error(body.error||'No se pudo iniciar sesión.');
    form.elements.password.value='';$('login-error').textContent='';await loadThreads();
  }catch(error){$('login-error').textContent=error.message;}finally{submit.disabled=false;}
});
void loadThreads();
