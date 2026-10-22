// Real Chromium + real React DOM; local SDK fixtures, not Electron integration.
// node tests/layout-browser.mjs [preview-dir] [existing-node_modules]
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
const dir=path.resolve(process.argv[2] || path.join(process.env.HOME,'.hermes/cache/scratch/office-layout-browser'))
const require=createRequire(path.join(process.argv[3] || '/Users/minisun/.hermes/hermes-agent/node_modules','../package.json'))
const {chromium}=require('playwright')
const server=http.createServer(async(req,res)=>{try{const file=path.resolve(dir,'.'+decodeURIComponent(req.url==='/'?'/index.html':req.url.split('?')[0]));if(!file.startsWith(dir+path.sep))throw Error('path');res.setHeader('Content-Type',file.endsWith('.js')||file.endsWith('.mjs')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await fs.readFile(file))}catch{res.statusCode=404;res.end()}})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser=await chromium.launch({headless:true}),page=await browser.newPage(),errors=[],results=[]
page.on('pageerror',e=>errors.push(String(e)))
const mixed=[{profile:'default',online:true,busy:true,active_sessions:2,active_agents:1,tokens_total:5000,cost_total:1.2},{profile:'research',online:true,busy:false,tokens_total:3000,cost_total:4},{profile:'offline',online:false,busy:false,tokens_total:9000,cost_total:2}]
const set=async(data,hidden=false,state={})=>{await page.evaluate(([d,h,s])=>window.__layout.set(d,h,s),[data,hidden,state]);await page.waitForTimeout(90)}
const counts=()=>page.locator('[data-count]').evaluateAll(nodes=>Object.fromEntries(nodes.map(n=>[n.dataset.count,Number(n.textContent)])))
try{
 await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForFunction(()=>window.__layout)
 for(const [name,data,expected] of [['online',mixed.map(e=>({...e,online:true})),{total:3,working:1,idle:2,offline:0}],['offline',mixed.map(e=>({...e,online:false,busy:false})),{total:3,working:0,idle:0,offline:3}],['mixed',mixed,{total:3,working:1,idle:1,offline:1}],['empty',[],{total:0,working:0,idle:0,offline:0}]]){
  for(const hide of [false,true]){await set(data,hide);assert.deepEqual(await counts(),expected);assert.equal(expected.total,expected.working+expected.idle+expected.offline);assert.equal(await page.locator('[data-office-overview]').count(),1);assert.equal(await page.locator('[data-profile-row]').count(),hide?data.filter(e=>e.online).length:data.length);const below=await page.evaluate(()=>document.querySelector('canvas')?document.querySelector('[data-office-overview]').getBoundingClientRect().bottom<document.querySelector('canvas').getBoundingClientRect().top:true);assert(below);results.push({case:name,hide,counts:await counts(),pass:true})}
 }
 // Invalid busy/offline input still belongs to exactly one category.
 assert.deepEqual(await page.evaluate(()=>window.__layout.profileOverview([{online:false,busy:true}])),{total:1,working:0,idle:0,offline:1})
 await set(mixed);assert.match(await page.locator('aside').innerText(),/All recorded sessions \(not today\)/)
 assert.equal(await page.locator('[data-profile-row]').first().getAttribute('data-profile-row'),'offline')
 await page.locator('[data-profile-row="offline"]').click();await page.getByRole('button',{name:'Open chat',exact:true}).click();assert.equal(await page.evaluate(()=>window.__opened),'offline')
 await page.evaluate(()=>window.__layout.hide(true));assert.match(await page.locator('aside').innerText(),/hidden from the scene\/list. Details remain selected/);assert(await page.getByRole('button',{name:'Open chat',exact:true}).isVisible())
 await page.evaluate(()=>window.__layout.hide(false));assert.equal(await page.locator('[data-profile-row="offline"]').getAttribute('class').then(c=>c.includes('/15')),true)
 await page.getByRole('button',{name:'cost',exact:true}).click();assert.equal(await page.locator('[data-profile-row]').first().getAttribute('data-profile-row'),'research')
 assert.match(await page.locator('aside').innerText(),/Sessions active in last 90s/);assert.match(await page.locator('aside').innerText(),/Gateway-reported agents/)
 await set(mixed.filter(e=>e.profile!=='offline'));assert.match(await page.locator('aside').innerText(),/no longer in the backend response/)
 await set([],false,{isLoading:true});assert.equal(await page.locator('[data-loading]').count(),1)
 await set([],false,{isError:true,error:{message:'fixture failure'}});assert.match(await page.locator('body').innerText(),/fixture failure/)
 results.push({case:'selection, hidden details, sorting, chat click, missing profile, loading/error',pass:true})
 // Absence of obsolete blocks is source-based, while mounted DOM has one overview.
 const src=await fs.readFile(path.join(dir,'plugin.source.js'),'utf8');assert(!/function Office(?:Legend|Stats)\(|jsx\(Office(?:Legend|Stats),/.test(src));results.push({case:'obsolete bottom blocks removed',pass:true})
 for(const width of [1440,390,320]){
  await page.setViewportSize({width,height:900});await set(mixed);await page.locator('[data-profile-row="research"]').click();await page.locator('[data-office-page]').evaluate(n=>n.scrollTop=0);await page.waitForTimeout(100)
  const layout=await page.evaluate(()=>{const p=document.querySelector('[data-office-page]'),c=document.querySelector('canvas'),a=document.querySelector('aside'),o=document.querySelector('[data-office-overview]');return {width:innerWidth,pageWidth:p.clientWidth,scrollWidth:p.scrollWidth,scrollHeight:p.scrollHeight,clientHeight:p.clientHeight,canvas:c.getBoundingClientRect().toJSON(),aside:a.getBoundingClientRect().toJSON(),overview:o.getBoundingClientRect().toJSON(),bodyOverflow:document.body.scrollWidth>innerWidth}})
  assert(layout.scrollWidth<=layout.pageWidth+1,JSON.stringify(layout));assert(!layout.bodyOverflow)
  if(width>=1024)assert(layout.aside.x>=layout.canvas.right-1);else assert(layout.aside.y>=layout.canvas.bottom-1)
  assert(layout.overview.bottom<=layout.canvas.y)
  // Expand only the scroll viewport to capture its complete content, preserving widths and vh sizing.
  if(width!==320){await page.locator('[data-office-page]').evaluate(n=>{n.style.height='auto';n.style.overflow='visible'});await page.screenshot({path:path.join(dir,`layout-${width>=1024?'wide':'narrow'}.png`),fullPage:true});await page.locator('[data-office-page]').evaluate(n=>{n.style.height='';n.style.overflow=''})}
  results.push({case:'responsive',width,layout,pass:true})
 }
 // Stress long profile names + list scrolling without changing the global scope.
 await set(Array.from({length:40},(_,i)=>({...mixed[i%3],profile:'worker-'+i+'-'+('long'.repeat(16))})))
 assert.equal(await page.locator('[data-count="total"]').innerText(),'40');assert(await page.locator('[data-profile-row]').first().evaluate(n=>n.parentElement.scrollHeight>n.parentElement.clientHeight));assert(await page.locator('[data-office-page]').evaluate(n=>n.scrollWidth<=n.clientWidth+1))
 assert.deepEqual(errors,[])
 const report={ok:true,boundary:'Real Chromium DOM + Canvas2D, real React and Tailwind compiled from existing local libraries. SDK query/atom/components/host are test fixtures, not Electron, backend or polling integration.',results,errors}
 await fs.writeFile(path.join(dir,'browser-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
}finally{await browser.close();server.close()}
