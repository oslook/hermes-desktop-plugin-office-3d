// Synthetic SDK harness exercising the actual page/chip query configuration; not a live UI test.
import { readFile } from 'node:fs/promises'
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm'
import assert from 'node:assert/strict'

const context = createContext({ console, setTimeout, clearTimeout })
const route = { connection: 'local', profile: 'default', epoch: 1 }
const host = { state: { connectionId: { get: () => route.connection }, profile: { get: () => route.profile } } }
let captured
const sdk = {
  ROUTES_AREA: 'routes', SIDEBAR_NAV_AREA: 'nav', STATUSBAR_AREAS: { right: 'right' }, PALETTE_AREA: 'palette', KEYBINDS_AREA: 'keys',
  host, atom: value => ({ get: () => value }), useValue: atom => atom.get(),
  useQuery: opts => (captured = opts, { isLoading: true }),
  gatewayActivationEpoch: () => route.epoch, useGatewayActivationEpoch: () => route.epoch,
  profileColor: () => '', cn: () => '', EmptyState: 'empty', ErrorState: 'error', Skeleton: 'skeleton', ListRow: 'row', ToggleRow: 'toggle', SegmentedControl: 'segment', Tip: 'tip',
}
const react = { useEffect: () => {}, useMemo: fn => fn(), useRef: initial => ({ current: initial }), useState: initial => [initial, () => {}] }
const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
function moduleFor(exports) {
  return new SyntheticModule(Object.keys(exports), function () { for (const [k,v] of Object.entries(exports)) this.setExport(k,v) }, { context })
}
const source = await readFile(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
const mod = new SourceTextModule(source + '\nexport { OfficeStatusChip, OfficePage };', { context })
await mod.link(specifier => moduleFor(specifier === '@hermes/plugin-sdk' ? sdk : specifier === 'react' ? react : jsx))
await mod.evaluate()
const prefs = { get: () => ({ pollSeconds: 5, hideOffline: false, notifyOnChange: false }) }
let resolveRequest
const ctx = { rest: () => new Promise(resolve => { resolveRequest = resolve }) }
function options(component) { mod.namespace[component]({ ctx, prefs }); return captured }
const chipA = options('OfficeStatusChip')
const pageA = options('OfficePage')
assert.equal(JSON.stringify(chipA.queryKey), JSON.stringify(pageA.queryKey))
const pending = chipA.queryFn()
route.connection = 'remote'; route.epoch++
const chipB = options('OfficeStatusChip')
assert.notEqual(JSON.stringify(chipA.queryKey), JSON.stringify(chipB.queryKey), 'connection switch must change key')
resolveRequest([{ profile: 'old' }])
await assert.rejects(pending, /route|switch|changed|stale/i)
route.profile = 'alpha'; route.epoch++
const pageC = options('OfficePage')
assert.notEqual(JSON.stringify(chipB.queryKey), JSON.stringify(pageC.queryKey), 'profile switch must change key')
route.profile = 'default'; route.epoch++
assert.notEqual(JSON.stringify(chipB.queryKey), JSON.stringify(options('OfficePage').queryKey), 'return activation must not revive stale data')
console.log('route-query: chip/page share route key; switches and late response fenced (mock SDK)')
