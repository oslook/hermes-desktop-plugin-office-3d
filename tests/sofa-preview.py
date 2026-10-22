#!/usr/bin/env python3
"""Build real-browser sofa regression page; stdlib only, all output in scratch.
Run: python3 tests/sofa-preview.py [saved-before-plugin.js]
Then serve the printed directory and open sofa-regression.html; read window.__results.
SDK/React stubs are for module loading only, never a fake canvas.
"""
from pathlib import Path
import re
import sys

repo = Path(__file__).resolve().parents[1]
out = Path.home() / '.hermes/cache/scratch/office3d-sofa-fix'
out.mkdir(parents=True, exist_ok=True)
source = (repo / 'desktop/plugin.js').read_text()
exports = '\nexport {drawSofa, sofaDims, loungeLayout, buildPalette, drawFrame, iso};\n'
before_path = Path(sys.argv[1]) if len(sys.argv) > 1 else out / 'plugin.before.js'
if not before_path.is_file():
    raise SystemExit('Provide the saved pre-fix plugin.js as the first argument for the negative control.')
for name, text in [('after', source), ('before', before_path.read_text())]:
    for spec, filename in [('@hermes/plugin-sdk', 'sdk.mjs'), ('react/jsx-runtime', 'jsx.mjs'), ('react', 'react.mjs')]:
        text = text.replace("from '" + spec + "'", "from './" + filename + "'")
    (out / (name + '.mjs')).write_text(text + exports)
# Only the imported public names; deliberately no ctx export.
match = re.search(r'import\s*\{([^}]+)\}\s*from \'@hermes/plugin-sdk\'', source)
assert match, 'SDK import not found'
names = match.group(1).split(',')
stubs = {'atom': '(v)=>({get:()=>v,set(){}})', 'profileColor': "()=>'#6ea8fe'", 'STATUSBAR_AREAS': "{right:'statusBar.right'}"}
(out / 'sdk.mjs').write_text('\n'.join('export const ' + n.strip() + '=' + stubs.get(n.strip(), '()=>({})') + ';' for n in names if n.strip()))
(out / 'react.mjs').write_text('export const useEffect=()=>{},useRef=()=>({}),useState=()=>[],useMemo=f=>f(),useCallback=f=>f;')
(out / 'jsx.mjs').write_text('export const jsx=()=>{},jsxs=()=>{};')
(out / 'sofa-regression.html').write_text((repo / 'tests/sofa-regression.html').read_text())
print(out)
