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
    if (new URL(request.url).searchParams.get('diagnostics') === '1') {
      const configured={whatsappToken:Boolean(env.WHATSAPP_TOKEN),phoneId:Boolean(env.WHATSAPP_PHONE_ID),webhookVerifyToken:Boolean(env.WHATSAPP_VERIFY_TOKEN),metaSignatureSecret:Boolean(env.META_APP_SECRET),geminiKey:Boolean(env.GEMINI_API_KEY)};
      let connection={checked:false};
      if(configured.whatsappToken && configured.phoneId){
        try {
          const url=new URL(`https://graph.facebook.com/v21.0/${encodeURIComponent(env.WHATSAPP_PHONE_ID)}`);
          url.searchParams.set('fields','display_phone_number,verified_name');
          const result=await fetch(url,{headers:{Authorization:`Bearer ${env.WHATSAPP_TOKEN}`},signal:AbortSignal.timeout(10000)});
          const data=await result.json();
          connection={checked:true,ok:result.ok,httpStatus:result.status,...(result.ok?{businessNumber:data.display_phone_number,businessName:data.verified_name}:{errorCode:data.error?.code || null,errorSubcode:data.error?.error_subcode || null})};
        }catch{connection={checked:true,ok:false,unavailable:true};}
      }
      return json(200,{configured,connection});
    }
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
