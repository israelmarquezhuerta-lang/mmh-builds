const test=require('node:test'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),path=require('node:path'),fs=require('node:fs');
const catalog=require('../catalog');
test('local checkout prices products on server, retains project requests and protects private files',async()=>{
 const temp=fs.mkdtempSync(path.resolve('work','checkout-test-'));const port=4196;const base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['server-local.js'],{env:{...process.env,PORT:String(port),MMH_DATA_DIRECTORY:temp},stdio:['ignore','pipe','pipe']});
 try{
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('server startup timeout')),10000);child.stdout.on('data',d=>{if(String(d).includes('disponible en')){clearTimeout(timer);resolve()}});child.on('error',reject);child.on('exit',code=>{if(code)reject(Error('server exit '+code))})});
 const post=async(route,body,cookie='')=>{const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',Origin:base,Cookie:cookie},body:JSON.stringify(body)});return{response:r,body:await r.json()}};
 const email='integration-'+Date.now()+'@example.test';const account=await post('/api/local/register',{name:'Checkout Test',email,phone:'5555555555',address:'Test address',password:'test-password-123!'});assert.equal(account.response.status,201);const cookie=account.response.headers.get('set-cookie').split(';')[0];
 const p=catalog.products.find(p=>p.supplierAvailable);const order=await post('/api/local/orders',{customer:{name:'Checkout Test',email,phone:'5555555555',address:'Test address'},items:[{id:p.id,quantity:2,price:1}]},cookie);assert.equal(order.response.status,201);assert.equal(order.body.order.total,catalog.productPrice(p)*2);assert.equal(order.body.order.discountRate,0);
 const project=await post('/api/local/orders',{customer:{name:'Checkout Test',email,phone:'5555555555',address:'Digital project'},items:[{id:'service-web',quantity:1,brief:'Online shop with 20 products'}]},cookie);assert.equal(project.response.status,201);assert.equal(project.body.order.quoteRequired,true);assert.equal(project.body.order.items[0].product.requestDetails,'Online shop with 20 products');
 const denied=await post('/api/local/orders',{customer:{},items:[{id:p.id,quantity:1}]});assert.equal(denied.response.status,401);
 for(const route of ['/work/backups/before-store-redesign.bundle','/oauth-core.mjs','/.env.local','/clave%20secreta%202.txt'])assert.equal((await fetch(base+route)).status,404);
 const providers=await(await fetch(base+'/api/auth/providers')).json();assert.deepEqual(providers,{google:false,microsoft:false});
 }finally{child.kill();}
});
