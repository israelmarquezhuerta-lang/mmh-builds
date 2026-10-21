import { hash } from '../../oauth-core.mjs';
import { ensureWhatsAppInbox } from '../../whatsapp-inbox.mjs';

const json = (status, body) => Response.json(body, {status, headers:{'Cache-Control':'no-store'}});
export async function onRequestGet({request,env}) {
  try {
    const token = (request.headers.get('cookie') || '').split(';').map(s=>s.trim()).find(s=>s.startsWith('mmh_local_session='))?.slice(18);
    if (!token) return json(401,{error:'Inicia sesión con tu cuenta MMH autorizada.'});
    if (!env.DB) return json(503,{error:'La base de datos no está disponible.'});
    const customer = await env.DB.prepare('SELECT email FROM sessions WHERE token_hash=? AND expires_at>?').bind(await hash(token),Date.now()).first();
    if (!customer) return json(401,{error:'La sesión caducó. Vuelve a entrar.'});
    const admins = String(env.MMH_ADMIN_EMAILS || '').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
    if (!admins.includes(customer.email.toLowerCase())) return json(403,{error:'Tu cuenta no está autorizada para consultar las conversaciones. Revisa el correo administrador configurado en MMH.'});
    await ensureWhatsAppInbox(env.DB);
    const phone = new URL(request.url).searchParams.get('phone');
    if (phone !== null) {
      if (!/^[0-9]{8,15}$/.test(phone)) return json(400,{error:'Número de conversación inválido.'});
      const rows=await env.DB.prepare(`SELECT message_id AS id,phone,contact_name AS contactName,direction,message_type AS type,body,status,created_at AS createdAt
        FROM (SELECT rowid AS sequence,* FROM whatsapp_messages WHERE phone=? ORDER BY created_at DESC,rowid DESC LIMIT 500)
        ORDER BY created_at ASC,sequence ASC`).bind(phone).all();
      return json(200,{phone,messages:rows.results || []});
    }
    const rows=await env.DB.prepare(`SELECT latest.phone,
      COALESCE((SELECT contact_name FROM whatsapp_messages WHERE phone=latest.phone AND contact_name IS NOT NULL AND contact_name!='' ORDER BY created_at DESC,rowid DESC LIMIT 1),latest.phone) AS contactName,
      latest.body AS lastMessage,latest.direction AS lastDirection,latest.created_at AS lastMessageAt,
      (SELECT COUNT(*) FROM whatsapp_messages WHERE phone=latest.phone) AS messageCount
      FROM whatsapp_messages latest WHERE latest.rowid=(SELECT rowid FROM whatsapp_messages WHERE phone=latest.phone ORDER BY created_at DESC,rowid DESC LIMIT 1)
      ORDER BY latest.created_at DESC LIMIT 200`).all();
    return json(200,{conversations:rows.results || []});
  } catch {
    return json(503,{error:'No se pudo consultar la bandeja. Inténtalo de nuevo.'});
  }
}
