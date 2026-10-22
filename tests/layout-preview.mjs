// Build actual React DOM preview; SDK-only fixtures, no Electron claim.
// node tests/layout-preview.mjs [output-directory] [existing-node_modules]
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const out=path.resolve(process.argv[2] || path.join(process.env.HOME,'.hermes/cache/scratch/office-layout-browser'))
const libs=process.argv[3] || '/Users/minisun/.hermes/hermes-agent/node_modules'
const require=createRequire(path.join(libs,'../package.json'))
const {build}=require('esbuild'), {compile}=require('@tailwindcss/node')
await fs.mkdir(out,{recursive:true})
const source=await fs.readFile(path.join(repo,'desktop/plugin.js'),'utf8')
if (/function Office(?:Stats|Legend)\(/.test(source)) throw Error('obsolete page blocks remain')
await fs.writeFile(path.join(out,'plugin.source.js'),source)
await fs.writeFile(path.join(out,'page.mjs'),source+'\nexport {OfficePage,profileOverview,officeView};\n')
const sdk=`import {createElement as h,useSyncExternalStore} from 'react';
export const ROUTES_AREA='routes', SIDEBAR_NAV_AREA='nav', STATUSBAR_AREAS={right:'right'}, PALETTE_AREA='palette', KEYBINDS_AREA='keys';
export const atom=v=>{const listeners=new Set();return {get:()=>v,set:n=>{v=n;listeners.forEach(f=>f())},subscribe:f=>{listeners.add(f);return ()=>listeners.delete(f)}}};
export const useValue=a=>useSyncExternalStore(a.subscribe,a.get);
export const query=atom({data:[],isLoading:false,isError:false});
export const useQuery=()=>useValue(query);
export const host={request:async()=>({sessions:[]}),newChat:p=>window.__opened=p,notifyError:()=>{},navigate:()=>{}};
export const profileColor=p=>['#6ea8fe','#e0ac6c','#b6b2ef'][String(p).length%3];
export const cn=(...a)=>a.filter(Boolean).join(' ');
export const EmptyState=({title,description})=>h('div',{'data-empty':true,className:'p-4'},h('h2',null,title),h('p',null,description));
export const ErrorState=EmptyState;
export const Skeleton=({className})=>h('div',{'data-loading':true,className});
export const SegmentedControl=({value,onChange,options})=>h('div',{className:'flex gap-2'},options.map(o=>h('button',{key:o.id,type:'button','aria-pressed':value===o.id,onClick:()=>onChange(o.id),className:'px-2 py-1 border rounded-md'},o.label)));
export const Tip=({children})=>children, ListRow=()=>null,ToggleRow=()=>null;
`
await fs.writeFile(path.join(out,'sdk.mjs'),sdk)
const entry=`import {createElement as h} from 'react'; import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {OfficePage,profileOverview,officeView} from './page.mjs';import {atom,query} from './sdk.mjs';
const prefs=atom({pollSeconds:5,hideOffline:false}),root=createRoot(document.querySelector('#root'));
const demo=[{profile:'default',online:true,busy:true,active_sessions:2,active_agents:1,tokens_total:5000,cost_total:1.2},{profile:'research',online:true,busy:false,tokens_total:3000,cost_total:4},{profile:'offline',online:false,busy:false,tokens_total:9000,cost_total:2}];query.set({data:demo,isLoading:false,isError:false});
window.__layout={demo,profileOverview,officeView,set:(data,hidden=false,state={})=>flushSync(()=>{query.set({data,isLoading:false,isError:false,...state});prefs.set({...prefs.get(),hideOffline:hidden})}),hide:v=>flushSync(()=>prefs.set({...prefs.get(),hideOffline:v})),prefs};
flushSync(()=>root.render(h(OfficePage,{ctx:{rest:async()=>[]},prefs})));
`
await fs.writeFile(path.join(out,'entry.mjs'),entry)
await build({entryPoints:[path.join(out,'entry.mjs')],outfile:path.join(out,'app.js'),bundle:true,format:'iife',nodePaths:[libs],alias:{'@hermes/plugin-sdk':path.join(out,'sdk.mjs')},define:{'process.env.NODE_ENV':'"production"'}})
const css=await compile('@import "tailwindcss";', {base:path.dirname(libs),onDependency:()=>{}})
const candidates=[...new Set((source+' '+sdk).split(/[\s'"`]+/))]
await fs.writeFile(path.join(out,'style.css'),css.build(candidates))
await fs.writeFile(path.join(out,'index.html'),`<!doctype html><html class="dark"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Office layout — React DOM / SDK fixture</title><link rel="stylesheet" href="style.css"><style>:root{--ui-bg:#16191e;--ui-text:#f0f2f5;--ui-text-secondary:#d9dfe8;--ui-text-tertiary:#a3adbc;--ui-accent:#6ea8fe;--ui-stroke-secondary:#39424f}html,body,#root{height:100%;margin:0;background:var(--ui-bg);color:var(--ui-text);font-family:system-ui,sans-serif}button{cursor:pointer}p{overflow-wrap:anywhere}</style><div id="root"></div><script src="app.js"></script></html>`)
await fs.copyFile(path.join(repo,'tests/layout-checks.html'),path.join(out,'checks.html'))
await fs.copyFile(path.join(repo,'tests/wheel-checks.html'),path.join(out,'wheel-checks.html'))
console.log(out)
