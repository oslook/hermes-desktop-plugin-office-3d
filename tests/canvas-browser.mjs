// Run the self-contained package's real Canvas2D regression pages.
// node tests/canvas-browser.mjs /absolute/path/to/package [existing-node_modules]
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
const dir=path.resolve(process.argv[2]),require=createRequire(path.join(process.argv[3]||'/Users/minisun/.hermes/hermes-agent/node_modules','../package.json')),{chromium}=require('playwright')
const server=http.createServer(async(req,res)=>{try{const file=path.resolve(dir,'.'+decodeURIComponent(req.url.split('?')[0]));if(!file.startsWith(dir+path.sep))throw Error('path');res.setHeader('Content-Type',/\.m?js$/.test(file)?'text/javascript':'text/html');res.end(await fs.readFile(file))}catch{res.statusCode=404;res.end()}})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser=await chromium.launch({headless:true}),page=await browser.newPage(),errors=[]
page.on('pageerror',e=>errors.push(String(e)))
try{
 for(const [url,target,key] of [['verification/poses/pose-regression.html','verification/poses/browser-results.json','ok'],['verification/sofa-regression.html','verification/browser-results.json','pass'],['verification/layout/checks.html','verification/layout/live-checks-results.json','ok']]){
  await page.goto(`http://127.0.0.1:${server.address().port}/${url}`);await page.waitForFunction(k=>window.__results?.[k]===true || window.__results?.errors?.length,key,{timeout:180000});const r=await page.evaluate(()=>window.__results);assert(r[key],JSON.stringify(r));await fs.writeFile(path.join(dir,target),JSON.stringify(r,null,2));console.log(url,JSON.stringify(r))
 }
 assert.deepEqual(errors,[])
}finally{await browser.close();server.close()}
