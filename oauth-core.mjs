import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';

const encoder = new TextEncoder();
const microsoftTenant = '9188040d-6c67-4c5b-b112-36a304b66dad';
const providers = {
  google: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', jwks: 'https://www.googleapis.com/oauth2/v3/certs', issuer: ['https://accounts.google.com','accounts.google.com'], id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET' },
  microsoft: { authorize: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token', jwks: 'https://login.microsoftonline.com/consumers/discovery/v2.0/keys', issuer: `https://login.microsoftonline.com/${microsoftTenant}/v2.0`, id: 'MICROSOFT_CLIENT_ID', secret: 'MICROSOFT_CLIENT_SECRET' }
};
const jwksCache = new Map();
const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
export async function hash(value) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))),b=>b.toString(16).padStart(2,'0')).join(''); }
const base64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const cookieName = provider => `__Host-mmh_oauth_${provider}`;
const stateCookie = (provider,value,age=600) => `${cookieName(provider)}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
const enabled = (provider,env) => Boolean(env[provider.id] && String(env[provider.secret]||'').length >= 16);
export const enabledProviders = env => Object.fromEntries(Object.entries(providers).map(([name,p])=>[name,enabled(p,env)]));
export async function signState(data, secret) { return new SignJWT(data).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('10m').setAudience('mmh-oauth-state').setIssuer('mmh-builds').sign(encoder.encode(secret)); }
export async function readState(value,secret) { const {payload}=await jwtVerify(value,encoder.encode(secret),{algorithms:['HS256'],audience:'mmh-oauth-state',issuer:'mmh-builds',clockTolerance:5});return payload; }
export async function verifyIdentityToken(token,providerName,clientId,nonce,keys) {
  const p=providers[providerName]; if(!p)throw new Error('invalid_provider');
  if(!keys){if(!jwksCache.has(p.jwks))jwksCache.set(p.jwks,createRemoteJWKSet(new URL(p.jwks)));keys=jwksCache.get(p.jwks);}
  const {payload}=await jwtVerify(token,keys,{algorithms:['RS256'],audience:clientId,issuer:p.issuer,clockTolerance:30,requiredClaims:['sub','iat','exp','nonce']});
  if(payload.nonce!==nonce||typeof payload.sub!=='string'||payload.sub.length>255)throw new Error('invalid_identity');
  if(providerName==='google' && payload.email_verified!==true)throw new Error('unverified_email');
  if(providerName==='microsoft' && payload.tid!==microsoftTenant)throw new Error('unsupported_tenant');
  const email=String(payload.email||'').trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)throw new Error('missing_email');
  return {subject:payload.sub,email,name:String(payload.name||email.split('@')[0]).slice(0,100)};
}
const identitySchema = `CREATE TABLE IF NOT EXISTS oauth_identities (provider TEXT NOT NULL, subject TEXT NOT NULL, email TEXT NOT NULL REFERENCES customers(email) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY (provider, subject))`;
async function establishSession(db,provider,identity) {
  await db.prepare(identitySchema).run();
  const linked=await db.prepare('SELECT email FROM oauth_identities WHERE provider = ? AND subject = ?').bind(provider,identity.subject).first();
  let email=linked?.email;
  if(!email){
    // Never attach a provider to an existing account solely on a matching email.
    const existing=await db.prepare('SELECT email FROM customers WHERE email = ?').bind(identity.email).first();
    if(existing)throw new Error('account_exists');
    email=identity.email;const salt=random().slice(0,32);const inaccessiblePassword=await hash(random()+random());
    await db.batch([
      db.prepare('INSERT INTO customers (email,name,phone,address,salt,password_hash,created_at) VALUES (?,?,?,?,?,?,?)').bind(email,identity.name,'','',salt,inaccessiblePassword,new Date().toISOString()),
      db.prepare('INSERT INTO oauth_identities (provider,subject,email,created_at) VALUES (?,?,?,?)').bind(provider,identity.subject,email,new Date().toISOString())
    ]);
  }
  const customer=await db.prepare('SELECT email FROM customers WHERE email = ?').bind(email).first();if(!customer)throw new Error('missing_customer');
  const session=random();await db.prepare('INSERT INTO sessions (token_hash,email,expires_at) VALUES (?,?,?)').bind(await hash(session),email,Date.now()+30*24*60*60*1000).run();return session;
}
function redirect(location,cookies=[]) {const headers=new Headers({Location:location,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});cookies.forEach(cookie=>headers.append('Set-Cookie',cookie));return new Response(null,{status:303,headers});}
export async function handleOAuth(request,env) {
  const url=new URL(request.url);
  if(url.pathname==='/api/auth/providers')return Response.json(enabledProviders(env),{headers:{'Cache-Control':'no-store'}});
  if(request.method!=='GET')return new Response('Method not allowed',{status:405,headers:{Allow:'GET'}});
  const match=url.pathname.match(/^\/api\/auth\/(google|microsoft)\/(start|callback)$/);if(!match)return new Response('Not found',{status:404});
  const [,name,action]=match,p=providers[name];
  if(!enabled(p,env))return Response.json({error:'Este acceso todavía no está disponible. Usa tu correo y contraseña.'},{status:503,headers:{'Cache-Control':'no-store'}});
  const origin=new URL(env.APP_BASE_URL||'https://mmh-builds.pages.dev').origin;
  if(!origin.startsWith('https://')||url.origin!==origin)return new Response('Invalid origin',{status:400});
  const redirectUri=origin+`/api/auth/${name}/callback`;
  if(action==='start'){
    const state=random(),nonce=random(),verifier=random();const challenge=base64url(await crypto.subtle.digest('SHA-256',encoder.encode(verifier)));
    const signed=await signState({provider:name,state,nonce,verifier},env[p.secret]);
    const authorize=new URL(p.authorize);authorize.search=new URLSearchParams({client_id:env[p.id],redirect_uri:redirectUri,response_type:'code',scope:'openid profile email',state,nonce,code_challenge:challenge,code_challenge_method:'S256',prompt:'select_account'}).toString();
    return redirect(authorize.href,[stateCookie(name,signed)]);
  }
  try {
    const cookie=(request.headers.get('cookie')||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName(name)+'='))?.slice(cookieName(name).length+1);
    if(!cookie||url.searchParams.has('error'))throw new Error('canceled');
    const saved=await readState(cookie,env[p.secret]);const code=url.searchParams.get('code');
    if(saved.provider!==name||saved.state!==url.searchParams.get('state')||!code||code.length>4096)throw new Error('invalid_state');
    const response=await fetch(p.token,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env[p.id],client_secret:env[p.secret],grant_type:'authorization_code',code,redirect_uri:redirectUri,code_verifier:saved.verifier}),signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('exchange_failed');const tokens=await response.json();
    const identity=await verifyIdentityToken(tokens.id_token,name,env[p.id],saved.nonce);
    if(!env.DB)throw new Error('missing_database');const session=await establishSession(env.DB,name,identity);
    return redirect(origin+'/#account-panel',[stateCookie(name,'',0),`mmh_local_session=${session}; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=2592000`]);
  }catch(error){const known=error.message==='account_exists'?'account_exists':'oauth_failed';return redirect(origin+'/?auth_error='+known,[stateCookie(name,'',0)]);}
}
