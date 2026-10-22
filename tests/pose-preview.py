#!/usr/bin/env python3
"""stdlib-only browser fixture builder. Pass saved dirty plugin.js, optional output dir."""
from pathlib import Path
import re, sys, shutil
repo = Path(__file__).resolve().parents[1]
out = Path(sys.argv[2]) if len(sys.argv)>2 else Path.home()/'.hermes/cache/scratch/office3d-pose/browser'
out.mkdir(parents=True, exist_ok=True)
source = (repo/'desktop/plugin.js').read_text()
before = Path(sys.argv[1]).read_text()
common = 'drawDeskAndAvatar,drawLoungeAvatar,drawLounge,drawFrame,buildPalette,iso,deskLayout,drawHead,loungeSlot'
for name,text in [('after',source),('before',before)]:
    for spec,file in [('@hermes/plugin-sdk','sdk.mjs'),('react/jsx-runtime','jsx.mjs'),('react','react.mjs')]:
        text=text.replace("from '"+spec+"'", "from './"+file+"'")
    pose_exports = [n for n in ['deskPose','loungePose','posePhase'] if re.search(r'function\s+'+n+r'\s*\(',text)]
    module=text+'\nexport {'+common+(','+','.join(pose_exports) if pose_exports else '')+'};\n'
    (out/(name+'.mjs')).write_text(module)
    # Diagnostic copies alter only sleeve ink, never geometry or paint order.
    diagnostic=module.replace('pose.hands[a],armW,armBase,P.skin)', "pose.hands[a],armW,a===0?'#ff00ff':'#00ffff',P.skin)")
    diagnostic=diagnostic.replace('project(capEnd),armW,armBase)', "project(capEnd),armW,'#ff00ff')")
    (out/(name+'-diagnostic.mjs')).write_text(diagnostic)
sdk_match = re.search(r"import\s*\{([^}]+)\}\s*from '@hermes/plugin-sdk'",source)
assert sdk_match, 'SDK import not found'
names = sdk_match.group(1).split(',')
values={'atom':'v=>({get:()=>v,set(){}})','profileColor':"()=>'#6ea8fe'",'STATUSBAR_AREAS':"{right:'statusBar.right'}"}
(out/'sdk.mjs').write_text('\n'.join('export const '+n.strip()+'='+values.get(n.strip(),'()=>({})')+';' for n in names if n.strip()))
(out/'react.mjs').write_text('export const useEffect=()=>{},useRef=()=>({}),useState=()=>[],useMemo=f=>f(),useCallback=f=>f;')
(out/'jsx.mjs').write_text('export const jsx=()=>{},jsxs=()=>{};')
shutil.copy2(repo/'tests/pose-regression.html',out/'pose-regression.html')
# Explicit historical negative control: fixed elbow must still fail fixed-bone checks.
legacy=(repo/'tests/fixtures/pre-ik-plugin.js').read_text()
for spec,file in [('@hermes/plugin-sdk','sdk.mjs'),('react/jsx-runtime','jsx.mjs'),('react','react.mjs')]:
    legacy=legacy.replace("from '"+spec+"'", "from './"+file+"'")
(out/'legacy-before.mjs').write_text(legacy+'\nexport {loungePose};\n')
shutil.copy2(Path(sys.argv[1]),out/'plugin.before.js')
print(out)
