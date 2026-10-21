const fs=require('node:fs');
const CATEGORIES=new Set(['gpu','cpu','motherboard','ram','storage','psu','case','monitor']);
function sanitizeProduct(row){
  const str=(v,max=250)=>{const s=String(v||'').trim();if(!s||s.length>max||/[<>\x00-\x1f]/.test(s))throw Error('Invalid text');return s;};
  const url=v=>{const u=new URL(v);if(u.protocol!=='https:'||!['www.cyberpuerta.mx','cyberpuerta.mx','cdn.cyberpuerta.mx'].includes(u.hostname)||u.username||u.password)throw Error('Invalid supplier URL');return u.href;};
  const category=str(row.category);if(!CATEGORIES.has(category))throw Error('Unsupported category');
  const price=Number(row.referencePrice);if(!Number.isFinite(price)||price<=0||price>10000000)throw Error('Invalid price');
  const sku=str(row.sku,150);const id='cp-'+sku.toLowerCase().replace(/[^a-z0-9]+/g,'-');
  const checked=new Date(row.sourceCheckedAt);if(!Number.isFinite(checked.getTime())||checked.getTime()>Date.now()+60000)throw Error('Invalid source date');
  if(typeof row.supplierAvailable!=='boolean')throw Error('Availability must be explicit');
  const images=[...new Set([row.image,...(row.images||[])])].slice(0,4).map(url);
  return {id,sku,category,type:str(row.type||category),brand:str(row.brand,100),name:str(row.name),referencePrice:Math.round(price*100)/100,supplier:'Cyberpuerta',supplierUrl:url(row.supplierUrl),sourceCheckedAt:checked.toISOString(),supplierAvailable:row.supplierAvailable,image:images[0],images,imageAlt:str(row.name),imageCredit:'Fotografía del producto · Cyberpuerta',imageSource:url(row.supplierUrl),availability:'Por pedido',discountEligible:false,specs:[str(row.type||category),str(row.brand,100),`SKU ${sku}`]};
}
function replaceCatalog(rows,target='catalog.js'){
 if(!Array.isArray(rows)||rows.length<1||rows.length>100000)throw Error('Expected between 1 and 100000 products');
 const products=rows.map(sanitizeProduct);if(new Set(products.map(p=>p.id)).size!==products.length)throw Error('Duplicate SKU');
 const text=fs.readFileSync(target,'utf8');const start=text.indexOf('  // BEGIN SUPPLIER PRODUCTS'),end=text.indexOf('  // END SUPPLIER PRODUCTS');if(start<0||end<0)throw Error('Missing generation markers');
 const output=text.slice(0,start)+'  // BEGIN SUPPLIER PRODUCTS\n  const products = '+JSON.stringify(products,null,2)+';\n'+text.slice(end);
 fs.writeFileSync(target,output);return products.length;
}
if(require.main===module){const input=process.argv[2];if(!input)throw Error('Usage: node scripts/import-catalog.cjs supplier-products.json');console.log('Imported',replaceCatalog(JSON.parse(fs.readFileSync(input,'utf8'))),'verified products');}
module.exports={sanitizeProduct,replaceCatalog};
