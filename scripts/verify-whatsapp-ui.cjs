// Run from repository root with Playwright installed. Synthetic API fixtures only.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const fs=require('node:fs'),http=require('node:http'),assert=require('node:assert/strict');
(async()=>{
 const fixture={id:'123:525500000001',phone_id:'123',wa_id:'525500000001',name:'Cliente <script>window.pwned=true</script>',mode:'bot',interest:'pc',needs_attention:0,unread:1,updated_at:Date.now(),last_inbound_at:Date.now(),window_expires_at:Date.now()+86400000};
 const msgs=[{id:1,direction:'in',sender:'customer',body:'Busco una PC <img src=x onerror="window.pwned=true">',created_at:Date.now(),status:'received'}];
 let sends=0,paused=false;
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','text/html; charset=utf-8');
  if(req.url==='/'){res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#0b1019;font-family:Arial;color:white}.shell{max-width:1100px;margin:auto}button{padding:10px}</style><link rel="stylesheet" href="/storefront.css"><main></main><script>let currentCustomer={email:"owner@test"};window.logout=()=>{currentCustomer=null;document.body.classList.toggle("logout")}</script><script src="/whatsapp-admin.js"></script>');return;}
  if(req.url==='/storefront.css'||req.url==='/whatsapp-admin.js'){res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8');res.end(fs.readFileSync('.'+req.url));return;}
  if(req.url.startsWith('/api/local/admin/whatsapp')){
   let input='';for await(const c of req)input+=c;const body=input?JSON.parse(input):{};res.setHeader('Content-Type','application/json');
   if(req.method==='GET'&&req.url.includes('/messages'))res.end(JSON.stringify({conversation:fixture,messages:msgs,more:false}));
   else if(req.method==='GET')res.end(JSON.stringify({conversations:[fixture],attention:1,page:0,more:false}));
   else if(req.url.endsWith('/mode')){fixture.mode=body.mode;paused=body.mode==='manual';res.end('{"ok":true}');}
   else if(req.url.endsWith('/messages')){assert.equal(paused,true);sends++;msgs.push({id:2,direction:'out',sender:'admin',body:body.text,status:'accepted',created_at:Date.now()});res.end('{"message":{"status":"accepted"}}');}
   else res.end('{"ok":true}');return;
  }res.statusCode=404;res.end();
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE ? {executablePath:process.env.CHROMIUM_EXECUTABLE,args:['--no-sandbox','--no-zygote','--single-process']} : {})});
 const page=await browser.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{for(const size of [{width:1440,height:1000},{width:390,height:844}]){
  fixture.mode='bot';msgs.splice(1);await page.setViewportSize(size);
  await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('[data-wa-select]').click();
  await page.locator('[data-wa-take]').click();await page.locator('textarea:enabled').fill('Hola, soy Israel. Te ayudo con tu equipo.');await page.locator('[data-wa-send]').click();
  await page.waitForFunction(()=>document.querySelector('[data-wa-messages]').textContent.includes('Te ayudo con tu equipo.'));
  assert.equal(await page.evaluate(()=>window.pwned),undefined);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:'work/inbox-'+size.width+'.png',fullPage:true});
  await page.locator('[data-wa-resume]').click();await page.waitForFunction(()=>document.querySelector('[data-wa-mode]').textContent==='Gemini activo');
  await page.evaluate(()=>window.logout());await page.waitForFunction(()=>document.querySelector('#whatsapp-center').hidden);
  assert.equal(await page.locator('[data-wa-client]').textContent(),'');assert.equal(await page.locator('[data-wa-messages]').textContent(),'');assert.deepEqual(errors,[]);
 }assert.equal(sends,2);console.log('Desktop + Android viewport: manual send, resume, XSS escaping, overflow and logout privacy passed.');}
 finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exit(1)});
