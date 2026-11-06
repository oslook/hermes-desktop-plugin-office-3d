// Exercise the real desktop module with a synthetic SDK; no live profiles accessed.
import { readFile } from 'node:fs/promises'
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm'
import assert from 'node:assert/strict'

const context = createContext({ console, setTimeout, clearTimeout })
let data = [{profile:'default', online:true, busy:true}, {profile:'alpha', display_name:'Alpha Display', online:false}, {profile:'new', online:true}]
let saved = {pollSeconds:15, hideOffline:true, notifyOnChange:true, custom:'keep'}
let registrations = {}, settings, effects = [], ref = {current:null}, notices = []
const host = {state:{connectionId:{get:()=> 'local'},profile:{get:()=> 'default'}}, notify:x=>notices.push(x)}
const sdk = { ROUTES_AREA:'routes', SIDEBAR_NAV_AREA:'nav', STATUSBAR_AREAS:{right:'right'}, PALETTE_AREA:'palette', KEYBINDS_AREA:'keys', host,
  atom: initial => {let value=initial; return {get:()=>value,set:v=>{value=v}}}, useValue:a=>a.get(), useQuery:()=>({data}), gatewayActivationEpoch:()=>1, useGatewayActivationEpoch:()=>1,
  profileColor:()=>'', cn:(...x)=>x.join(' '), EmptyState:'empty', ErrorState:'error', Skeleton:'skeleton', ListRow:'row', ToggleRow:'toggle', SegmentedControl:'segment', Tip:'tip' }
const react = {useEffect:fn=>effects.push(fn),useMemo:fn=>fn(),useRef:()=>ref,useState:initial=>[initial,()=>{}]}
const jsx = {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})}
function moduleFor(exports) {return new SyntheticModule(Object.keys(exports),function(){for(const [k,v] of Object.entries(exports)) this.setExport(k,v)},{context})}
const source = await readFile(new URL('../desktop/plugin.js',import.meta.url),'utf8')
const mod = new SourceTextModule(source+'\nexport { officeView, readPrefs };',{context})
await mod.link(s=>moduleFor(s==='@hermes/plugin-sdk'?sdk:s==='react'?react:jsx)); await mod.evaluate()
const ctx = {storage:{get:()=>saved,set:(_key,value)=>{saved=value}}, register:r=>{registrations[r.id]=r}, registerSettingsPage:r=>{settings=r}}
mod.namespace.default.register(ctx)
const render = el => typeof el.type === 'function' ? render(el.type(el.props)) : el
const nodes = node => !node || typeof node !== 'object' ? [] : [node,...(Array.isArray(node.props?.children)?node.props.children:[node.props?.children]).flatMap(nodes)]
const getButtons = () => nodes(render(settings.render())).filter(n=>n.type==='button' && n.props['aria-pressed'] !== undefined)
let buttons = getButtons()
assert.equal(buttons.length,3,'settings lists all discovered profiles including offline and default')
assert.deepEqual(Array.from(buttons,b=>b.props.children),['default','alpha','new'],'settings labels use only profile IDs, not display names')
assert.ok(buttons.every(b=>b.props['aria-pressed']===true),'all profiles enabled by default')
const enabledStyle = buttons[0].props.style
assert.equal(enabledStyle?.backgroundColor, 'var(--ui-accent)', 'enabled background is applied without relying on compiled utilities')
buttons[0].props.onClick()
assert.deepEqual(Array.from(saved.excludedProfileIds),['default'])
assert.equal(saved.custom,'keep'); assert.equal(saved.pollSeconds,15)
buttons=getButtons(); assert.equal(buttons[0].props['aria-pressed'],false)
assert.equal(buttons[0].props.style?.backgroundColor, 'var(--ui-bg-tertiary)', 'disabled background is applied without relying on compiled utilities')
assert.notEqual(buttons[0].props.style.backgroundColor, enabledStyle.backgroundColor)
if (process.env.OFFICE_STYLE_PROBE) console.log('STYLE_PROBE ' + JSON.stringify({enabled:enabledStyle,disabled:buttons[0].props.style}))
mod.namespace.default.register(ctx)
assert.equal(getButtons()[0].props['aria-pressed'],false,'saved preference survives registration')
data.push({profile:'later',online:true})
assert.equal(getButtons()[3].props['aria-pressed'],true,'new profile defaults to enabled')
data.pop()
buttons=getButtons()
let view=mod.namespace.officeView(data,true,'default',saved.excludedProfileIds)
assert.deepEqual(Array.from(view.visible,e=>e.profile),['new'])
assert.equal(view.selected,null,'disabled profile details are not visible')
assert.equal(view.all.length,2,'overview excludes disabled profile')
const page=render(registrations.page.render())
const pageNodes=nodes(page)
assert.equal(pageNodes.find(n=>n.type?.name==='OfficeOverview').props.entries.length,2)
assert.deepEqual(Array.from(pageNodes.find(n=>n.type?.name==='OfficeLeaderboard').props.entries,e=>e.profile),['new'])
let chip=render(registrations.status.render()); assert.equal(chip.props.children.props.children[1].props.children,'1 online')
effects.splice(0).forEach(f=>f()); data=[{...data[0],busy:false},data[1],data[2]]
render(registrations.status.render()); effects.splice(0).forEach(f=>f()); assert.equal(notices.length,0,'excluded profile changes do not notify')
buttons[0].props.onClick(); assert.deepEqual(Array.from(saved.excludedProfileIds),[])
render(registrations.status.render()); effects.splice(0).forEach(f=>f()); assert.equal(notices.length,0,'re-enabling seeds notification state')
assert.equal(getButtons()[0].props['aria-pressed'],true)
assert.deepEqual(Array.from(mod.namespace.readPrefs({storage:{get:()=>({excludedProfileIds:'bad'})}}).excludedProfileIds),[])
// A routed specialist is still filterable even when delegation marks it busy.
const delegated = [{profile:'default',online:true}, {profile:'worker',online:true,busy:true,delegated_sessions:1}]
const hiddenDelegated = mod.namespace.officeView(delegated,false,'worker',['worker'])
assert.deepEqual(Array.from(hiddenDelegated.all,e=>e.profile),['default'])
assert.equal(hiddenDelegated.selected,null)
assert.deepEqual(Array.from(mod.namespace.officeView(delegated,false,'worker',[]).all,e=>e.profile),['default','worker'])
console.log('profile-visibility: settings, persistence, filtering, chip and notification behavior passed')
