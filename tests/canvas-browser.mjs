// Run this package's real Canvas2D regression pages from a bare checkout.
//
//   node tests/canvas-browser.mjs [--work=<dir>] [--libs=<node_modules>] [--pose-baseline=<plugin.js>]
//
// The previous revision only worked inside a built *release* bundle: it hardcoded
// `verification/poses/...`, `verification/sofa-regression.html` and
// `verification/layout/checks.html`, none of which exist in the repository, so it
// died on a 404 and covered nothing. It now builds every bundle from the repo's
// own builders, serves it, and trusts each page's `window.__results` verdict:
//
//   layout  tests/layout-checks.html    (built by tests/layout-preview.mjs)
//   sofa    tests/sofa-regression.html  (built by tests/sofa-preview.py; the
//           checked-in tests/fixtures/pre-ik-plugin.js is the negative control)
//   pose    tests/pose-regression.html  (built by tests/pose-preview.py) — opt-in
//
// Why pose is opt-in: that page is a *patch-verification* artifact from the
// session that fixed the tea/typing pose. It diffs the current build against
// "the dirty baseline I just fixed" and asserts that baseline fails the new
// oracles. No commit satisfies both of its demands — "workstation furniture
// byte-identical to today" (needs the display-name labels from 2d58f05 onward)
// and "the old sphere head is still there" (dropped in the same range) — so the
// baseline cannot be reconstructed from git. Pass --pose-baseline=<file> with a
// saved copy to run it; otherwise it is reported as SKIP, never silently ignored.
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import os from 'node:os'
import {existsSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = new Map(process.argv.slice(2).map(arg => {
  const [key, ...rest] = arg.split('=')
  return [key.replace(/^--/, ''), rest.length ? rest.join('=') : true]
}))

const BUNDLED_LIBS = '/Users/minisun/.hermes/hermes-agent/node_modules'
const libs = path.resolve(args.get('libs') || (existsSync(BUNDLED_LIBS) ? BUNDLED_LIBS : path.join(repoDir, 'node_modules')))
const work = path.resolve(args.get('work') || path.join(process.env.HOME || os.tmpdir(), '.hermes/cache/scratch/office3d-canvas'))
const python = process.env.PYTHON || 'python3'
const poseBaseline = args.get('pose-baseline')

const require = createRequire(path.join(libs, '..', 'package.json'))
const {chromium} = require('playwright')
await fs.mkdir(work, {recursive: true})

function build(name, command, commandArgs) {
  const out = spawnSync(command, commandArgs, {cwd: repoDir, encoding: 'utf8'})
  if (out.status !== 0) {
    throw new Error(`${name} bundle failed (${command} ${commandArgs.join(' ')}):\n${out.stderr || out.stdout}`)
  }
}

const serve = dir => http.createServer(async (req, res) => {
  try {
    const rel = decodeURIComponent(req.url.split('?')[0])
    const file = path.resolve(dir, '.' + (rel === '/' ? '/index.html' : rel))
    if (!file.startsWith(dir + path.sep)) throw new Error('path escape')
    const body = await fs.readFile(file)
    res.setHeader('Content-Type', /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html')
    res.end(body)
  } catch {
    res.statusCode = 404
    res.end('not found')
  }
})

async function runPage(browser, dir, page, key) {
  const server = serve(dir)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const tab = await browser.newPage()
  const pageErrors = []
  tab.on('pageerror', error => pageErrors.push(String(error)))
  try {
    await tab.goto(`http://127.0.0.1:${server.address().port}/${page}`)
    // Every page publishes window.__results once it has a verdict; a failing page
    // sets the verdict false and drops the thrown message into `errors`.
    await tab.waitForFunction(k => {
      const r = window.__results
      return !!r && (typeof r[k] === 'boolean' || (Array.isArray(r.errors) && r.errors.length > 0))
    }, key, {timeout: 300000})
    const results = await tab.evaluate(() => window.__results)
    return {ok: results[key] === true, results, pageErrors}
  } catch (error) {
    return {ok: false, error: String(error), pageErrors}
  } finally {
    await tab.close()
    server.close()
  }
}

const report = {ok: true, work, libs, pages: [], errors: []}
const browser = await chromium.launch({headless: true})
try {
  // 1. Layout — the shipped React page in a real DOM.
  const layoutDir = path.join(work, 'layout')
  build('layout', process.execPath, ['tests/layout-preview.mjs', layoutDir, libs])
  report.pages.push({name: 'layout', file: 'tests/layout-checks.html',
    ...await runPage(browser, layoutDir, 'checks.html', 'ok')})

  // 2. Sofa — real colours against an independent ray/box occlusion oracle, with
  //    the checked-in pre-fix module as the negative control (it must mismatch).
  const sofaDir = path.join(work, 'sofa')
  build('sofa', python, ['tests/sofa-preview.py', 'tests/fixtures/pre-ik-plugin.js', sofaDir])
  report.pages.push({name: 'sofa', file: 'tests/sofa-regression.html',
    ...await runPage(browser, sofaDir, 'sofa-regression.html', 'pass')})

  // 3. Poses — opt-in only (see the header comment for why).
  if (poseBaseline) {
    const poseDir = path.join(work, 'poses')
    build('pose', python, ['tests/pose-preview.py', path.resolve(String(poseBaseline)), poseDir])
    report.pages.push({name: 'pose', file: 'tests/pose-regression.html',
      ...await runPage(browser, poseDir, 'pose-regression.html', 'ok')})
  } else {
    report.pages.push({name: 'pose', file: 'tests/pose-regression.html', skipped: true,
      reason: 'needs the pre-fix plugin.js baseline, which never existed in git; pass --pose-baseline=<file>'})
  }
} finally {
  await browser.close()
}

for (const page of report.pages) {
  if (page.skipped) continue
  if (!page.ok) report.ok = false
  if (page.pageErrors?.length) report.errors.push(...page.pageErrors)
}
await fs.writeFile(path.join(work, 'canvas-results.json'), JSON.stringify(report, null, 2))

for (const page of report.pages) {
  if (page.skipped) {
    console.log(`SKIP ${page.name} — ${page.reason}`)
    continue
  }
  const r = page.results
  const detail = r && r.pixels
    ? `surfaces=${r.pixels.reduce((n, x) => n + x.tested, 0)} mismatches=${r.pixels.reduce((n, x) => n + x.mismatches, 0)}`
      + ` · negative control mismatches=${r.negativeControl.reduce((n, x) => n + x.mismatches, 0)}`
    : r ? `checks=${r.checks ?? r.geometry?.length ?? '?'}` : page.error
  console.log(`${page.ok ? 'PASS' : 'FAIL'} ${page.name} — ${detail}`)
  if (!page.ok) {
    const why = page.results?.errors ?? page.results?.error ?? page.error
    if (why) console.log('  ' + JSON.stringify(why))
  }
}
console.log(`report: ${path.join(work, 'canvas-results.json')}`)
if (!report.ok) process.exitCode = 1
