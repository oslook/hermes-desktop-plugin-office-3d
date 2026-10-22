// Real React DOM + Chromium WheelEvent regression (SDK fixtures only).
// node tests/wheel-browser.mjs <built-layout-directory> [existing-node_modules]
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
const dir=path.resolve(process.argv[2]),require=createRequire(path.join(process.argv[3]||'/Users/minisun/.hermes/hermes-agent/node_modules','../package.json'))
const {chromium}=require('playwright')
const server=http.createServer(async(req,res)=>{try{const file=path.resolve(dir,'.'+(req.url==='/'?'/index.html':req.url.split('?')[0]));if(!file.startsWith(dir+path.sep))throw Error('path');res.setHeader('Content-Type',/\.m?js$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await fs.readFile(file))}catch{res.statusCode=404;res.end()}})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser=await chromium.launch({headless:true}),page=await browser.newPage(),errors=[],warnings=[],results=[]
page.on('pageerror',e=>errors.push(String(e)))
page.on('console',m=>{if(/passive|preventDefault/i.test(m.text()))warnings.push(m.text())})
try{
 await page.addInitScript(()=>{
  // Observe real registrations without replacing browser event semantics.
  window.__wheelListeners=[]
  const add=EventTarget.prototype.addEventListener,remove=EventTarget.prototype.removeEventListener
  EventTarget.prototype.addEventListener=function(type,fn,options){if(type==='wheel'&&this instanceof HTMLCanvasElement)window.__wheelListeners.push({target:this,fn,options,removed:false});return add.call(this,type,fn,options)}
  EventTarget.prototype.removeEventListener=function(type,fn,options){if(type==='wheel')for(const l of window.__wheelListeners)if(l.target===this&&l.fn===fn)l.removed=true;return remove.call(this,type,fn,options)}
 })
 await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForSelector('canvas');await page.waitForTimeout(100)
 const zoom=()=>page.getByTitle('Back to fit (100%)',{exact:true}).innerText()
 const reset=()=>page.getByTitle('Back to fit (100%)',{exact:true}).click()
 const wheel=opts=>page.locator('canvas').evaluate((c,opts)=>{const r=c.getBoundingClientRect(),e=new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-120,clientX:r.left+r.width/2,clientY:r.top+r.height/2,...opts});const dispatched=c.dispatchEvent(e);return {defaultPrevented:e.defaultPrevented,dispatched,cancelable:e.cancelable}},opts)
 for(const key of ['ctrlKey','metaKey']){
  await reset();const event=await wheel({[key]:true});await page.waitForTimeout(30)
  const actual=await zoom();results.push({case:key,event,zoom:actual});assert.equal(event.defaultPrevented,true,`${key}: browser default must be prevented`);assert.equal(event.dispatched,false);assert.equal(actual,Math.round(Math.pow(1.0018,120)*100)+'%','exactly one zoom per DOM event')
 }
 await reset();const plain=await wheel({});await page.waitForTimeout(30);assert.equal(plain.defaultPrevented,false);assert.equal(plain.dispatched,true);assert.equal(await zoom(),'100%');results.push({case:'plain wheel',event:plain,zoom:await zoom()})
 await reset();await wheel({ctrlKey:true,deltaMode:1,deltaY:-3});await page.waitForTimeout(30);assert.equal(await zoom(),Math.round(Math.pow(1.0018,48)*100)+'%');results.push({case:'line delta normalization',zoom:await zoom()})
 await reset();await page.locator('canvas').evaluate(c=>{for(let i=0;i<2;i++)c.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,ctrlKey:true,deltaY:-120}))});await page.waitForTimeout(30);assert.equal(await zoom(),Math.round(Math.pow(1.0018,240)*100)+'%');results.push({case:'same-task burst uses latest view',zoom:await zoom()})
 await page.getByTitle('Zoom in',{exact:true}).click();await wheel({metaKey:true});await page.waitForTimeout(30);assert.equal(await zoom(),Math.round(Math.pow(1.0018,360)*1.3*100)+'%');results.push({case:'button then native wheel uses latest view',zoom:await zoom()})
 await page.evaluate(()=>{window.__oldCanvas=document.querySelector('canvas');window.__layout.set([],false,{isLoading:true})});await page.waitForTimeout(50)
 const cleanup=await page.evaluate(()=>{const c=window.__oldCanvas,e=new WheelEvent('wheel',{cancelable:true,ctrlKey:true,deltaY:-120});c.dispatchEvent(e);return {registrations:window.__wheelListeners.length,active:window.__wheelListeners.filter(l=>!l.removed).length,passive:window.__wheelListeners.map(l=>l.options.passive),defaultPrevented:e.defaultPrevented}})
 assert(cleanup.registrations>0);assert.equal(cleanup.active,0);assert(cleanup.passive.every(v=>v===false));assert.equal(cleanup.defaultPrevented,false);results.push({case:'unmount removes non-passive listener',...cleanup})
 await page.evaluate(()=>window.__layout.set(window.__layout.demo));await page.waitForSelector('canvas');await page.waitForTimeout(50);const remount=await wheel({ctrlKey:true});await page.waitForTimeout(30);assert.equal(remount.defaultPrevented,true);assert.equal(await zoom(),Math.round(Math.pow(1.0018,120)*100)+'%');assert.equal(await page.evaluate(()=>window.__wheelListeners.filter(l=>!l.removed).length),1);results.push({case:'remount exactly one active listener',event:remount,zoom:await zoom()})
 await page.goto(`http://127.0.0.1:${server.address().port}/wheel-checks.html`)
 await page.waitForFunction(()=>window.__results,{timeout:30000})
 const live=await page.evaluate(()=>window.__results);assert.equal(live.ok,true,JSON.stringify(live))
 await fs.writeFile(path.join(dir,'wheel-live-results.json'),JSON.stringify(live,null,2))
 results.push({case:'self-contained live HTML',checks:live.results.length,pass:true})
 assert.deepEqual(errors,[]);assert.deepEqual(warnings,[])
 const report={ok:true,boundary:'Real React DOM, real Chromium cancelable WheelEvent dispatch; SDK fixture, not Electron or physical trackpad.',results,errors,warnings}
 await fs.writeFile(path.join(dir,'wheel-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
}finally{await browser.close();server.close()}
