// ~/.hermes/desktop-plugins/office-3d/plugin.js
//
// Office 3D — fake-isometric office view of the Hermes profile gateways.
// Each profile owns a desk in the WORK zone; when busy (online AND
// active_agents > 0) the avatar sits at the desk and its hands "type".
// Idle/online avatars relax in the LOUNGE zone with tea. Offline avatars
// are greyed out in the lounge and their monitor is dark.
//
// Rendering: 2D canvas with an isometric projection. The disk-plugin
// import whitelist forbids three.js / WebGL; only @hermes/plugin-sdk,
// react, and react/jsx-runtime may be imported. No JSX syntax.

import {
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  useQuery,
  profileColor,
  cn,
  EmptyState,
  ErrorState,
  Skeleton,
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useMemo, useRef } from 'react'

// ---------------------------------------------------------------------------
// Isometric projection helpers.
// World coordinates: x → east, y → north, z → up. Small integer units.
// ---------------------------------------------------------------------------
const ISO_X = Math.SQRT1_2 // cos(45°) ≈ 0.7071
const ISO_Y = 0.5          // classic isometric-ish tilt

function iso(x, y, z, scale) {
  const sx = (x - y) * ISO_X * scale
  const sy = ((x + y) * ISO_Y - z) * scale
  return [sx, sy]
}

// ---------------------------------------------------------------------------
// Color helpers.
// ---------------------------------------------------------------------------
function hexToRgb(hex) {
  if (!hex || typeof hex !== 'string') return null
  let h = hex.trim()
  if (h[0] !== '#') return null
  if (h.length === 4) {
    h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3]
  }
  if (h.length !== 7) return null
  const r = parseInt(h.slice(1, 3), 16)
  const g = parseInt(h.slice(3, 5), 16)
  const b = parseInt(h.slice(5, 7), 16)
  if ([r, g, b].some((v) => Number.isNaN(v))) return null
  return { r, g, b }
}

function shade(hex, amount) {
  // amount: -1..1 ; negative darkens, positive lightens
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  const mix = amount >= 0 ? 255 : 0
  const t = Math.abs(amount)
  const r = Math.round(rgb.r + (mix - rgb.r) * t)
  const g = Math.round(rgb.g + (mix - rgb.g) * t)
  const b = Math.round(rgb.b + (mix - rgb.b) * t)
  return 'rgb(' + r + ', ' + g + ', ' + b + ')'
}

function rgba(hex, a) {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  return 'rgba(' + rgb.r + ', ' + rgb.g + ', ' + rgb.b + ', ' + a + ')'
}

// Darken a profile-hued name ink in LIGHT mode so it stays legible on the
// near-white pill (P.pillColor). In DARK mode the raw profile color is
// already legible on the dark pill, so pass it through unchanged.
function nameInk(pcolor, P) {
  return P && P.mode === 'light' ? shade(pcolor, -0.45) : pcolor
}

// Format elapsed idle duration compactly.
// <60s  -> "idle 45s"
// <60m  -> "idle 12m"
// else  -> "idle 2h3m"
function formatIdle(elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) elapsedMs = 0
  const totalSec = Math.floor(elapsedMs / 1000)
  if (totalSec < 60) return 'idle ' + totalSec + 's'
  const totalMin = Math.floor(totalSec / 60)
  if (totalMin < 60) return 'idle ' + totalMin + 'm'
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return 'idle ' + h + 'h' + m + 'm'
}

// Format a large token count compactly: 1234 -> "1.2k", 1_500_000 -> "1.5M",
// 1_200_000_000 -> "1.2B". Values <1000 render as-is.
function formatCompact(n) {
  if (!Number.isFinite(n)) return '0'
  const abs = Math.abs(n)
  if (abs < 1000) return String(Math.trunc(n))
  const units = [
    { v: 1e9, s: 'B' },
    { v: 1e6, s: 'M' },
    { v: 1e3, s: 'k' },
  ]
  for (const u of units) {
    if (abs >= u.v) {
      const q = n / u.v
      // 1 decimal, but drop trailing ".0"
      const s = (Math.round(q * 10) / 10).toFixed(1)
      return (s.endsWith('.0') ? s.slice(0, -2) : s) + u.s
    }
  }
  return String(Math.trunc(n))
}

// Draw text with a subtle dark stroke/shadow behind it so it stays legible
// over the floor. Assumes caller has already set font, textAlign, and fillStyle.
function drawTextWithHalo(c, text, x, y) {
  const prevLineWidth = c.lineWidth
  const prevStroke = c.strokeStyle
  const prevJoin = c.lineJoin
  const prevMiter = c.miterLimit
  c.lineWidth = 3
  c.strokeStyle = 'rgba(0, 0, 0, 0.55)'
  c.lineJoin = 'round'
  c.miterLimit = 2
  c.strokeText(text, x, y)
  c.lineWidth = prevLineWidth
  c.strokeStyle = prevStroke
  c.lineJoin = prevJoin
  c.miterLimit = prevMiter
  c.fillText(text, x, y)
}

// Draw a pill-shaped background badge behind a name label so it stays
// legible over the isometric floor regardless of underlying colors.
//
// Convention: the canvas context is already scale(dpr, dpr) transformed
// in drawFrame(), so all other draw code in this file uses raw CSS-pixel
// units (font "10px ...", lineWidth 1, etc.). We follow the same
// convention here — no explicit dpr multipliers — so the badge scales
// with the rest of the scene automatically.
//
// Caller MUST have already set c.font and c.textAlign = 'center'.
// opts: { fontPx, textColor, borderColor?, dotColor? }
function drawNameBadge(c, text, cx, y, opts) {
  const fontPx = opts && opts.fontPx ? opts.fontPx : 10
  const padX = 5
  const padY = 2
  const textW = c.measureText(text).width
  const dotR = opts && opts.dotColor ? fontPx * 0.28 : 0
  const dotGap = dotR > 0 ? dotR + 3 : 0
  const innerW = textW + dotGap
  const width = innerW + padX * 2
  const height = fontPx + padY * 2
  const rectX = cx - width / 2
  const rectY = y - height / 2
  const r = height / 2

  // Rounded-rect pill path (inline; no helper exists in this file).
  c.beginPath()
  c.moveTo(rectX + r, rectY)
  c.lineTo(rectX + width - r, rectY)
  c.arcTo(rectX + width, rectY, rectX + width, rectY + r, r)
  c.lineTo(rectX + width, rectY + height - r)
  c.arcTo(rectX + width, rectY + height, rectX + width - r, rectY + height, r)
  c.lineTo(rectX + r, rectY + height)
  c.arcTo(rectX, rectY + height, rectX, rectY + height - r, r)
  c.lineTo(rectX, rectY + r)
  c.arcTo(rectX, rectY, rectX + r, rectY, r)
  c.closePath()

  c.fillStyle = (opts && opts.pillColor) ? opts.pillColor : 'rgba(8, 10, 14, 0.9)'
  c.fill()
  if (opts && opts.borderColor) {
    const prevLW = c.lineWidth
    const prevSS = c.strokeStyle
    c.lineWidth = 1
    c.strokeStyle = opts.borderColor
    c.stroke()
    c.lineWidth = prevLW
    c.strokeStyle = prevSS
  }

  // Optional identity dot on the left inside the pill.
  let textCX = cx
  if (dotR > 0) {
    const dotCX = rectX + padX + dotR
    const dotCY = rectY + height / 2
    const prevFS = c.fillStyle
    c.beginPath()
    c.arc(dotCX, dotCY, dotR, 0, Math.PI * 2)
    c.fillStyle = opts.dotColor
    c.fill()
    c.fillStyle = prevFS
    // Nudge text right so it doesn't collide with the dot.
    textCX = cx + dotGap / 2
  }

  // Draw text last, vertically centered in the pill.
  const prevBaseline = c.textBaseline
  const prevFill = c.fillStyle
  c.textBaseline = 'middle'
  c.fillStyle = opts.textColor
  c.fillText(text, textCX, rectY + height / 2)
  c.textBaseline = prevBaseline
  c.fillStyle = prevFill
}

// ---------------------------------------------------------------------------
// Iso primitives.
// ---------------------------------------------------------------------------
function drawIsoBox(c, ox, oy, x, y, z, w, d, h, scale, colors) {
  const [tlx, tly] = iso(x, y, z + h, scale)
  const [trx, try_] = iso(x + w, y, z + h, scale)
  const [brx, bry] = iso(x + w, y + d, z + h, scale)
  const [blx, bly] = iso(x, y + d, z + h, scale)

  const [tblx, tbly] = iso(x, y + d, z, scale)
  const [tbrx, tbry] = iso(x + w, y + d, z, scale)
  const [tfrx, tfry] = iso(x + w, y, z, scale)

  c.lineWidth = 1
  c.strokeStyle = colors.stroke

  // Front-right face (visible toward viewer along +x side)
  c.beginPath()
  c.moveTo(ox + trx, oy + try_)
  c.lineTo(ox + brx, oy + bry)
  c.lineTo(ox + tbrx, oy + tbry)
  c.lineTo(ox + tfrx, oy + tfry)
  c.closePath()
  c.fillStyle = colors.right
  c.fill()
  c.stroke()

  // Front-left face (+y side)
  c.beginPath()
  c.moveTo(ox + brx, oy + bry)
  c.lineTo(ox + blx, oy + bly)
  c.lineTo(ox + tblx, oy + tbly)
  c.lineTo(ox + tbrx, oy + tbry)
  c.closePath()
  c.fillStyle = colors.left
  c.fill()
  c.stroke()

  // Top face
  c.beginPath()
  c.moveTo(ox + tlx, oy + tly)
  c.lineTo(ox + trx, oy + try_)
  c.lineTo(ox + brx, oy + bry)
  c.lineTo(ox + blx, oy + bly)
  c.closePath()
  c.fillStyle = colors.top
  c.fill()
  c.stroke()
}

function drawIsoDisc(c, ox, oy, x, y, z, radius, scale, fill, stroke) {
  const [cx, cy] = iso(x, y, z, scale)
  c.save()
  c.translate(ox + cx, oy + cy)
  c.scale(1, ISO_Y / ISO_X) // squash for fake perspective
  c.beginPath()
  c.arc(0, 0, radius * scale, 0, Math.PI * 2)
  c.restore()
  c.fillStyle = fill
  c.fill()
  if (stroke) {
    c.strokeStyle = stroke
    c.lineWidth = 1
    c.stroke()
  }
}

function drawSphere(c, ox, oy, x, y, z, radius, scale, fill, stroke) {
  const [cx, cy] = iso(x, y, z, scale)
  c.beginPath()
  c.arc(ox + cx, oy + cy, radius * scale, 0, Math.PI * 2)
  c.fillStyle = fill
  c.fill()
  if (stroke) {
    c.strokeStyle = stroke
    c.lineWidth = 1
    c.stroke()
  }
}

// ---------------------------------------------------------------------------
// Scene layout.
// ---------------------------------------------------------------------------
const DESK_COLS = 3
const DESK_ROW_SPACING = 3.2
const DESK_COL_SPACING = 3.6
const WORK_ORIGIN = { x: 0.5, y: 0.5 }
const LOUNGE_ORIGIN = { x: 0.5, y: 8.5 }

function deskSlot(index) {
  const col = index % DESK_COLS
  const row = Math.floor(index / DESK_COLS)
  return {
    x: WORK_ORIGIN.x + col * DESK_COL_SPACING,
    y: WORK_ORIGIN.y + row * DESK_ROW_SPACING,
  }
}

function loungeSlot(index, total) {
  const t = total > 0 ? total : 1
  const angle = (index / t) * Math.PI * 2
  const r = 1.7
  return {
    x: LOUNGE_ORIGIN.x + 2.0 + Math.cos(angle) * r,
    y: LOUNGE_ORIGIN.y + 1.6 + Math.sin(angle) * r,
  }
}

// ---------------------------------------------------------------------------
// Palette that FOLLOWS the Hermes global theme. buildPalette reads the app's
// --ui-bg each frame and picks a light or dark scene palette from its
// luminance, so toggling Hermes's theme flips the office automatically.
// getComputedStyle also supplies the accent color.
// ---------------------------------------------------------------------------
function buildPalette(canvas, mode) {
  const cs = getComputedStyle(canvas)
  const accentDark = (cs.getPropertyValue('--ui-accent') || '#4c9aff').trim() || '#4c9aff'
  const accentLight = (cs.getPropertyValue('--ui-accent') || '#2563eb').trim() || '#2563eb'
  // FOLLOW THE HOST THEME via the definitive signal: Hermes toggles a `.dark`
  // class on document.documentElement (:root.dark in styles.css, Tailwind
  // darkMode:class). No color parsing / luminance guessing needed.
  let isDark = true
  try {
    isDark = document.documentElement.classList.contains('dark')
  } catch (e) {
    isDark = true
  }
  const isLight = !isDark
  if (isLight) {
    return {
      mode: 'light',
      bg: '#f4f5f7',
      stroke: '#c9ced6',
      textSec: '#3a3f45',
      textTer: '#6b7280',
      textQuat: '#9aa1ab',
      accent: accentLight,
      // Floor overlays: dark-tinted rgba on light bg so zones read.
      floorWorkFill: 'rgba(20, 24, 32, 0.05)',
      floorLoungeFill: 'rgba(20, 24, 32, 0.09)',
      // Furniture (lighter greys for chair + monitor body on light bg).
      chairTop: '#c3c8d0',
      chairLeft: '#b0b6c0',
      chairRight: '#a0a6b0',
      chairBackTop: '#cfd4dc',
      chairBackLeft: '#bcc2cb',
      chairBackRight: '#a9afb8',
      monitorStandTop: '#b8bcc4',
      monitorStandLeft: '#a6abb4',
      monitorStandRight: '#969ba4',
      screenOff: '#dfe3e8',
      screenOffGlow: '#e8ecf1',
      // Screen ON base/glow — cool but LIGHT-tinted so the terminal-green
      // content still reads and the monitor doesn't look muddy on the light bg.
      screenOnBase: '#b7ccd4',
      screenOnGlow: '#cfe0e6',
      stool: '#b0b6c0',
      // Screen-on green (slightly darker on light bg for contrast).
      screenGreenBusy: '#1f9d57',
      screenGreenIdle: '#178a49',
      // Name pill: light with subtle border and dark text.
      pillColor: 'rgba(255, 255, 255, 0.85)',
      pillBorder: 'rgba(0, 0, 0, 0.15)',
      offlineNameColor: '#9aa1ab',
    }
  }
  // DARK (default; keeps existing look).
  const cs2 = cs
  return {
    mode: 'dark',
    bg: ((cs2.getPropertyValue('--ui-bg') || '#0b0d10').trim() || '#0b0d10'),
    stroke: '#2a2f36',
    textSec: '#c8ccd1',
    textTer: '#8b9098',
    textQuat: '#5b6169',
    accent: accentDark,
    floorWorkFill: rgba(accentDark, 0.04),
    floorLoungeFill: rgba(accentDark, 0.07),
    chairTop: '#3a3f45',
    chairLeft: '#2c3035',
    chairRight: '#232629',
    chairBackTop: '#43484e',
    chairBackLeft: '#333840',
    chairBackRight: '#282c31',
    monitorStandTop: '#333',
    monitorStandLeft: '#222',
    monitorStandRight: '#111',
    screenOff: '#151719',
    screenOffGlow: '#1c1f22',
    screenOnBase: '#263d47',
    screenOnGlow: '#2f4a55',
    stool: '#2c3035',
    screenGreenBusy: '#39ff88',
    screenGreenIdle: '#2fbf6a',
    pillColor: 'rgba(8, 10, 14, 0.9)',
    pillBorder: null,
    offlineNameColor: '#5a5f66',
  }
}

// ---------------------------------------------------------------------------
// Frame draw.
// ---------------------------------------------------------------------------
function drawFrame(canvas, c, entries, tSec, mode) {
  const P = buildPalette(canvas, mode)
  const bg = P.bg
  const stroke = P.stroke
  const textSec = P.textSec
  const textTer = P.textTer
  const textQuat = P.textQuat
  const accent = P.accent

  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
  const cssW = canvas.clientWidth || 640
  const cssH = canvas.clientHeight || 400

  // Stats moved to DOM chips below the canvas; no in-canvas bar reserve.
  const BOTTOM_BAR_H = 0
  const sceneH = Math.max(120, cssH - BOTTOM_BAR_H)

  c.setTransform(1, 0, 0, 1, 0, 0)
  c.clearRect(0, 0, canvas.width, canvas.height)
  c.scale(dpr, dpr)

  // Background
  c.fillStyle = bg
  c.fillRect(0, 0, cssW, cssH)

  // Compute scale to fit the whole scene bounds into the canvas.
  // Scene extents in world XY: roughly x∈[0, 11], y∈[0, 12].
  const worldW = 11
  const worldH = 12
  const projW = (worldW + worldH) * ISO_X
  const projH = (worldW + worldH) * ISO_Y + 3.0
  const margin = 24
  const scaleFit = Math.min(
    (cssW - margin * 2) / projW,
    (sceneH - margin * 2) / projH,
  )
  const scale = Math.max(14, Math.min(64, scaleFit))

  // Origin: shift so leftmost projected x sits at the margin.
  const leftMost = (0 - worldH) * ISO_X * scale
  const topMost = -3.0 * scale
  const ox = margin - leftMost + Math.max(0, (cssW - margin * 2 - projW * scale) / 2)
  const oy = margin - topMost

  // Zone floors
  drawFloor(c, ox, oy, 0, 0, worldW, 6.5, scale, {
    fill: P.floorWorkFill,
    stroke,
  })
  drawFloor(c, ox, oy, 0, 7.0, worldW, 6.0, scale, {
    fill: P.floorLoungeFill,
    stroke,
  })

  // Zone labels — bottom-right corner of each zone.
  c.font = '10px system-ui, -apple-system, "Segoe UI", sans-serif'
  c.fillStyle = textTer
  c.textAlign = 'right'
  {
    const [lx, ly] = iso(worldW, 6.5, 0, scale)
    c.fillText('WORK', ox + lx + 24, oy + ly - 22)
  }
  {
    const [lx, ly] = iso(worldW, 13.0, 0, scale)
    c.fillText('LOUNGE', ox + lx + 24, oy + ly - 22)
  }
  c.textAlign = 'start'

  // Lounge furniture (drawn behind lounge avatars because sofa is at higher y).
  drawLounge(c, ox, oy, scale, stroke, textQuat, accent, tSec, P)

  // Desks & at-desk avatars — painter's order, back to front.
  const desks = entries.map((entry, i) => ({ entry, i, slot: deskSlot(i) }))
  desks.sort((a, b) => (a.slot.x + a.slot.y) - (b.slot.x + b.slot.y))
  for (const { entry, i, slot } of desks) {
    drawDeskAndAvatar(c, ox, oy, scale, slot, entry, i, tSec,
      { stroke, textSec, textTer, textQuat, accent, P })
  }

  // Lounge avatars — only ONLINE-but-idle profiles relax here.
  // Offline profiles are NOT drawn in the lounge (they simply haven't shown
  // up); their desk sits empty with a dark screen instead.
  const lounged = entries
    .map((entry, i) => ({ entry, i }))
    .filter(({ entry }) => entry.online && !entry.busy)
  lounged.forEach(({ entry, i }, idx) => {
    const slot = loungeSlot(idx, lounged.length)
    drawLoungeAvatar(c, ox, oy, scale, slot, entry, i, tSec, idx,
      { stroke, textSec, textTer, accent, P })
  })

  // -------------------------------------------------------------------------
  // (Aggregate stats now render as DOM chips below the canvas — see
  // OfficeStats — not painted here, so the canvas stays a clean scene.)
  // -------------------------------------------------------------------------
}

// Draws a slim status strip at the very bottom of the canvas showing
// aggregate metrics across every profile: total active sessions, total
// tokens (compact), total cost (hidden if all zero), and total agents
// (display-only, comes from gateway state).
function drawStatusBar(c, cssW, cssH, barH, entries, palette) {
  const { stroke, textSec, textTer, accent } = palette
  const list = Array.isArray(entries) ? entries : []
  let online = 0
  let busy = 0
  let sessions = 0
  let tokens = 0
  let cost = 0
  let agents = 0
  for (const e of list) {
    if (!e || typeof e !== 'object') continue
    if (e.online) online++
    if (e.busy) busy++
    sessions += Number(e.active_sessions) || 0
    tokens += Number(e.tokens_total) || 0
    cost += Number(e.cost_total) || 0
    agents += Number(e.active_agents) || 0
  }

  const y0 = Math.max(0, cssH - barH)

  // Solid-ish backdrop so the bar reads clearly over the scene.
  c.save()
  c.fillStyle = 'rgba(0, 0, 0, 0.55)'
  c.fillRect(0, y0, cssW, barH)
  // Bright-ish top divider.
  c.strokeStyle = stroke
  c.lineWidth = 1
  c.beginPath()
  c.moveTo(0, y0 + 0.5)
  c.lineTo(cssW, y0 + 0.5)
  c.stroke()

  const cy = y0 + barH / 2
  const padX = 12
  const valFont = '600 12px system-ui, -apple-system, "Segoe UI", sans-serif'
  const labFont = '10px system-ui, -apple-system, "Segoe UI", sans-serif'

  // A metric = colored value + dim label, laid out left-to-right.
  c.textBaseline = 'middle'
  c.textAlign = 'left'
  let x = padX
  const metric = (value, label, valColor) => {
    c.font = valFont
    c.fillStyle = valColor || textSec
    c.fillText(value, x, cy)
    x += c.measureText(value).width + 4
    if (label) {
      c.font = labFont
      c.fillStyle = textTer
      c.fillText(label, x, cy)
      x += c.measureText(label).width
    }
    // separator
    x += 8
    c.font = labFont
    c.fillStyle = textTer
    c.fillText('·', x, cy)
    x += c.measureText('·').width + 8
  }

  // Left cluster: online / busy / sessions / tokens.
  metric(String(online), 'online', accent)
  metric(String(busy), 'busy', busy > 0 ? '#39ff88' : textTer)
  metric(String(sessions), 'active', textSec)
  // tokens is the last left metric — no trailing separator, so draw manually.
  c.font = valFont
  c.fillStyle = textSec
  c.fillText(formatCompact(tokens), x, cy)
  x += c.measureText(formatCompact(tokens)).width + 4
  c.font = labFont
  c.fillStyle = textTer
  c.fillText('tokens', x, cy)

  // Right cluster: cost (if any) + agents.
  c.textAlign = 'right'
  let rx = cssW - padX
  // agents
  c.font = labFont
  c.fillStyle = textTer
  c.fillText('agents', rx, cy)
  rx -= c.measureText('agents').width + 4
  c.font = valFont
  c.fillStyle = textSec
  c.fillText(String(agents), rx, cy)
  rx -= c.measureText(String(agents)).width + 12
  // cost (only if > 0)
  if (cost > 0) {
    c.font = labFont
    c.fillStyle = textTer
    c.fillText('·', rx, cy)
    rx -= c.measureText('·').width + 8
    c.font = valFont
    c.fillStyle = '#ffd479'
    c.fillText('$' + cost.toFixed(2), rx, cy)
  }

  c.restore()
}

function drawFloor(c, ox, oy, x, y, w, d, scale, style) {
  const [ax, ay] = iso(x, y, 0, scale)
  const [bx, by] = iso(x + w, y, 0, scale)
  const [cx, cy] = iso(x + w, y + d, 0, scale)
  const [dx, dy] = iso(x, y + d, 0, scale)
  c.beginPath()
  c.moveTo(ox + ax, oy + ay)
  c.lineTo(ox + bx, oy + by)
  c.lineTo(ox + cx, oy + cy)
  c.lineTo(ox + dx, oy + dy)
  c.closePath()
  c.fillStyle = style.fill
  c.fill()
  c.lineWidth = 1
  c.strokeStyle = style.stroke
  c.stroke()
}

function drawLounge(c, ox, oy, scale, stroke, tint, accent, tSec, palette) {
  const P = palette || {}
  const isLight = P.mode === 'light'
  // Sofa fabric base: a muted blue-grey in dark, a soft light fabric in light.
  const sofa = isLight ? '#b9c2cf' : shade(accent, -0.4)
  const sofaBack = isLight ? '#c4ccd8' : shade(accent, -0.35)
  // Coffee-table wood: deep walnut in dark, light oak in light.
  const wood = isLight ? '#c9a876' : '#6b4b2a'
  // Sofa (drawn first, at back). Original position; the lounge floor is sized
  // to contain its back edge (see drawFloor depth for the lounge).
  const sx = LOUNGE_ORIGIN.x + 0.6
  const sy = LOUNGE_ORIGIN.y + 3.2
  drawIsoBox(c, ox, oy, sx, sy, 0, 3.2, 1.0, 0.5, scale, {
    top: shade(sofa, 0.06),
    left: shade(sofa, -0.14),
    right: shade(sofa, -0.24),
    stroke,
  })
  drawIsoBox(c, ox, oy, sx, sy + 0.8, 0.5, 3.2, 0.2, 1.0, scale, {
    top: shade(sofaBack, 0.06),
    left: shade(sofaBack, -0.14),
    right: shade(sofaBack, -0.22),
    stroke,
  })

  // Coffee table
  const tx = LOUNGE_ORIGIN.x + 1.4
  const ty = LOUNGE_ORIGIN.y + 1.0
  drawIsoBox(c, ox, oy, tx, ty, 0, 1.4, 1.0, 0.35, scale, {
    top: shade(wood, 0.15),
    left: shade(wood, -0.15),
    right: shade(wood, -0.3),
    stroke,
  })

  // Teacups — 🍵 emoji on the table (with a gentle bob).
  c.save()
  c.textAlign = 'center'
  c.textBaseline = 'middle'
  const cupPx = Math.max(9, Math.round(scale * 0.32))
  c.font = cupPx + 'px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif'
  for (let i = 0; i < 3; i++) {
    const cxw = tx + 0.0 + i * 0.45
    const cyw = ty + 0.25
    const bob = 0.03 * Math.sin(tSec * 2 + i)
    const [px, py] = iso(cxw, cyw, 0.12 + bob, scale)
    c.fillText('🍵', ox + px, oy + py)
  }
  c.textAlign = 'start'
  c.textBaseline = 'alphabetic'
  c.restore()
}

function drawDeskAndAvatar(c, ox, oy, scale, slot, entry, index, tSec, palette) {
  const { stroke, textSec, textTer, textQuat, accent, P } = palette
  const online = !!entry.online
  const busy = !!entry.busy
  const alpha = online ? 1 : 0.45
  const pcolor = profileColor(entry.profile) || accent

  c.save()
  c.globalAlpha = alpha

  // Desk
  drawIsoBox(c, ox, oy, slot.x, slot.y, 0, 2.2, 1.1, 0.75, scale, {
    top: shade('#9c7a52', 0.15),
    left: shade('#9c7a52', -0.15),
    right: shade('#9c7a52', -0.3),
    stroke,
  })

  // Monitor stand + screen at the back edge of the desk
  const monX = slot.x + 0.7
  const monY = slot.y + 0.15
  drawIsoBox(c, ox, oy, monX + 0.3, monY + 0.15, 0.75, 0.2, 0.2, 0.08, scale, {
    top: P.monitorStandTop, left: P.monitorStandLeft, right: P.monitorStandRight, stroke,
  })
  // Screen face: neutral cool-grey so it doesn't clash with the
  // profile-colored person. Brightness alone signals on/off:
  // online = lit cool-grey, offline = dark screen (or light-grey in light mode).
  const screenGlow = online ? P.screenOnGlow : P.screenOffGlow
  const screenBase = online ? P.screenOnBase : P.screenOff
  drawIsoBox(c, ox, oy, monX, monY, 0.83, 0.85, 0.08, 0.6, scale, {
    top: screenGlow,
    left: screenBase,
    right: shade(screenBase, -0.3),
    stroke,
  })

  // Screen CONTENT when online: fake code/UI lines painted on the screen face
  // so a running station looks alive. The face spans x∈[monX, monX+0.85] at
  // y=monY+0.08 (front), z∈[0.83, 1.43]. Map (u,v)∈[0,1]² onto it via iso().
  if (online) {
    const faceY = monY + 0.08
    const zBot = 0.83
    const zTop = 1.43
    // Point on the screen face in screen space.
    const sp = (u, v) => {
      const [px, py] = iso(monX + u * 0.85, faceY, zBot + v * (zTop - zBot), scale)
      return [ox + px, oy + py]
    }
    c.save()
    // Screen content is terminal-green regardless of profile hue.
    const screenText = busy ? P.screenGreenBusy : P.screenGreenIdle
    // Title bar across the top.
    c.strokeStyle = screenText
    c.lineWidth = 2
    let [x0, y0] = sp(0.12, 0.85)
    let [x1, y1] = sp(0.6, 0.85)
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke()
    // Code lines: a few left-aligned rows of varying width, brighter when busy.
    c.lineWidth = busy ? 1.6 : 1.2
    const rows = [
      [0.12, 0.68, 0.62],
      [0.20, 0.56, 0.70],
      [0.20, 0.44, 0.48],
      [0.12, 0.32, 0.66],
      [0.28, 0.20, 0.40],
    ]
    for (let i = 0; i < rows.length; i++) {
      const [uStart, v, uLen] = rows[i]
      c.strokeStyle = screenText
      const [ax, ay] = sp(uStart, v)
      const [bx, by] = sp(uStart + uLen, v)
      c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.stroke()
    }
    // Busy: a blinking cursor block at the end of an active line.
    if (busy) {
      const blink = (Math.sin(tSec * 4 + index) + 1) / 2
      c.globalAlpha = 0.35 + 0.55 * blink
      c.fillStyle = screenText
      const [cxp, cyp] = sp(0.62, 0.68)
      const [cxp2] = sp(0.66, 0.68)
      const cw = Math.abs(cxp2 - cxp) || 3
      c.fillRect(cxp, cyp - 3, cw, 6)
    }
    c.restore()
  }

  // Chair — behind the desk (+y). Neutral dark-grey so the profile-colored
  // person sitting in it stays visually distinct from the seat.
  const chairX = slot.x + 0.6
  const chairY = slot.y + 1.3
  drawIsoBox(c, ox, oy, chairX, chairY, 0, 0.9, 0.9, 0.5, scale, {
    top: P.chairTop,
    left: P.chairLeft,
    right: P.chairRight,
    stroke,
  })
  // Chair BACK is drawn later (after the person) so it correctly occludes
  // the sitter's lower back — in iso painter's order the backrest sits at the
  // highest +y and must paint last.
  const drawChairBack = () => {
    drawIsoBox(c, ox, oy, chairX, chairY + 0.7, 0.5, 0.9, 0.2, 0.9, scale, {
      top: P.chairBackTop,
      left: P.chairBackLeft,
      right: P.chairBackRight,
      stroke,
    })
  }

  // At-desk avatar only when busy
  if (busy) {
    const typing = 0.05 * Math.sin(tSec * 6 + index)
    const bodyH = 0.9
    const bodyX = chairX + 0.15
    const bodyY = chairY + 0.15
    const bodyZ = 0.55 + typing
    drawIsoBox(c, ox, oy, bodyX, bodyY, bodyZ, 0.6, 0.6, bodyH, scale, {
      top: shade(pcolor, 0.1),
      left: shade(pcolor, -0.15),
      right: shade(pcolor, -0.3),
      stroke,
    })
    const headCX = bodyX + 0.3
    const headCY = bodyY + 0.3
    const headCZ = bodyZ + bodyH + 0.25
    const headR = 0.28
    drawSphere(c, ox, oy,
      headCX, headCY, headCZ,
      headR, scale, shade(pcolor, 0.35), stroke)

    // Backrest paints after the body/head so it occludes the sitter's back.
    drawChairBack()

    // Hands over the desk, alternating vertical offset — "typing".
    const beat = Math.sin(tSec * 10 + index)
    const t1 = beat > 0 ? 0.05 : 0.0
    const t2 = beat > 0 ? 0.0 : 0.05
    const handZ = 0.83
    drawSphere(c, ox, oy,
      monX + 0.2, monY + 0.75, handZ + t1,
      0.09, scale, shade(pcolor, 0.4), stroke)
    drawSphere(c, ox, oy,
      monX + 0.6, monY + 0.75, handZ + t2,
      0.09, scale, shade(pcolor, 0.4), stroke)

    // Floating name label just above the head disc (busy avatars are always online).
    const [nhx, nhy] = iso(headCX, headCY, headCZ + headR, scale)
    const nameFontPx = 10
    c.font = nameFontPx + 'px system-ui, -apple-system, "Segoe UI", sans-serif'
    c.textAlign = 'center'
    drawNameBadge(c, entry.profile, ox + nhx, oy + nhy - 6, {
      fontPx: nameFontPx,
      textColor: nameInk(pcolor, P),
      borderColor: P.pillBorder,
      pillColor: P.pillColor,
      dotColor: null,
    })
    c.textAlign = 'start'
  } else {
    // Empty chair (idle/offline): still draw the backrest for a complete chair.
    drawChairBack()
  }

  // When NOT busy, the desk is empty (idle -> person is in the lounge;
  // offline -> person hasn't shown up). Still label the empty desk above the
  // chair so you can tell whose station it is. Offline reads dim (grey);
  // idle reads in the profile color.
  if (!busy) {
    const [dnx, dny] = iso(monX + 0.4, monY + 0.4, 2.1, scale)
    const deskNameFontPx = 10
    c.save()
    c.globalAlpha = 1
    c.font = deskNameFontPx + 'px system-ui, -apple-system, "Segoe UI", sans-serif'
    c.textAlign = 'center'
    drawNameBadge(c, entry.profile, ox + dnx, oy + dny, {
      fontPx: deskNameFontPx,
      textColor: online ? nameInk(pcolor, P) : P.offlineNameColor,
      borderColor: P.pillBorder,
      pillColor: P.pillColor,
      dotColor: null,
    })
    c.textAlign = 'start'
    c.restore()
  }

  c.restore()
}

function drawLoungeAvatar(c, ox, oy, scale, slot, entry, index, tSec, idx, palette) {
  const { stroke, textSec, textTer, accent, P } = palette
  const online = !!entry.online
  const alpha = online ? 1 : 0.35
  const pcolor = profileColor(entry.profile) || accent
  const bob = online ? 0.05 * Math.sin(tSec * 2 + idx) : 0

  c.save()
  c.globalAlpha = alpha

  // Small stool disc under the avatar (neutral, not profile-colored).
  drawIsoDisc(c, ox, oy, slot.x, slot.y, 0.02, 0.36, scale, P.stool, stroke)

  const bodyZ = 0.05 + bob
  drawIsoBox(c, ox, oy, slot.x - 0.25, slot.y - 0.25, bodyZ, 0.5, 0.5, 0.7, scale, {
    top: shade(pcolor, 0.1),
    left: shade(pcolor, -0.15),
    right: shade(pcolor, -0.3),
    stroke,
  })
  const headCZ = bodyZ + 0.7 + 0.22
  const headR = 0.24
  drawSphere(c, ox, oy,
    slot.x, slot.y, headCZ,
    headR, scale, shade(pcolor, 0.35), stroke)

  // Raised tea cup only if online (idle-online); offline avatars sit slouched.
  if (online) {
    const cupZ = bodyZ + 0.6 + 0.03 * Math.sin(tSec * 3 + idx)
    drawIsoDisc(c, ox, oy,
      slot.x + 0.2, slot.y - 0.1, cupZ,
      0.09, scale, '#f2ede4', stroke)
    c.save()
    c.globalAlpha = alpha * (0.35 + 0.25 * Math.sin(tSec * 2 + idx))
    c.strokeStyle = '#e6d9c2'
    c.lineWidth = 1
    const [sPx, sPy] = iso(slot.x + 0.2, slot.y - 0.1, cupZ + 0.05, scale)
    c.beginPath()
    c.moveTo(ox + sPx, oy + sPy)
    c.quadraticCurveTo(ox + sPx + 3, oy + sPy - 6, ox + sPx - 2, oy + sPy - 12)
    c.stroke()
    c.restore()
  }

  // Floating name label just above the head disc.
  // Draw at full opacity (outside the avatar's dimming alpha) so the name
  // stays legible even when the avatar is offline/greyed.
  const [nhx, nhy] = iso(slot.x, slot.y, headCZ + headR, scale)
  const nameY = oy + nhy - 6
  const nameFontPx = 10
  c.save()
  c.globalAlpha = 1
  c.font = nameFontPx + 'px system-ui, -apple-system, "Segoe UI", sans-serif'
  c.textAlign = 'center'
  drawNameBadge(c, entry.profile, ox + nhx, nameY, {
    fontPx: nameFontPx,
    textColor: nameInk(pcolor, P),
    borderColor: P.pillBorder,
    pillColor: P.pillColor,
    dotColor: null,
  })

  // Idle duration — only for online, non-busy avatars with a valid idle_since.
  // (drawLoungeAvatar is only called when !busy, so we just check online + idle_since.)
  if (online && entry.idle_since != null && Number.isFinite(entry.idle_since)) {
    const elapsedMs = Date.now() - entry.idle_since * 1000
    const idleFontPx = 9
    c.font = idleFontPx + 'px system-ui, -apple-system, "Segoe UI", sans-serif'
    // Profile-colored text on the dark pill, same as the name, so it reads
    // clearly. Placed ABOVE the name pill (smaller screen-y) so it never
    // overlaps the avatar's head/body which sit below the name.
    drawNameBadge(c, formatIdle(elapsedMs), ox + nhx, nameY - (nameFontPx + 2), {
      fontPx: idleFontPx,
      textColor: nameInk(pcolor, P),
      borderColor: P.pillBorder,
      pillColor: P.pillColor,
      dotColor: null,
    })
  }
  c.textAlign = 'start'
  c.restore()

  c.restore()
}

// ---------------------------------------------------------------------------
// React components.
// ---------------------------------------------------------------------------
function OfficeCanvas({ entries }) {
  const containerRef = useRef(null)
  const canvasRef = useRef(null)
  const rafRef = useRef(0)
  const startRef = useRef(0)
  const entriesRef = useRef(entries)

  useEffect(() => {
    entriesRef.current = entries
  }, [entries])

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return
    const c2 = canvas.getContext('2d')
    if (!c2) return

    const resize = () => {
      const rect = container.getBoundingClientRect()
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
      const w = Math.max(200, Math.floor(rect.width))
      const h = Math.max(200, Math.floor(rect.height))
      canvas.style.width = w + 'px'
      canvas.style.height = h + 'px'
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
    }
    resize()

    const ro = new ResizeObserver(() => resize())
    ro.observe(container)

    startRef.current = performance.now()

    const tick = (now) => {
      rafRef.current = 0
      if (!document.hidden) {
        const tSec = (now - startRef.current) / 1000
        try {
          drawFrame(canvas, c2, entriesRef.current || [], tSec)
        } catch (err) {
          // Never let a draw error kill the loop.
          // eslint-disable-next-line no-console
          console.error('[office-3d] draw error', err)
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)

    const onVis = () => {
      if (!document.hidden && rafRef.current === 0) {
        rafRef.current = requestAnimationFrame(tick)
      }
    }
    document.addEventListener('visibilitychange', onVis)

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
      ro.disconnect()
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  return jsx('div', {
    ref: containerRef,
    className: cn('relative w-full h-full min-h-[380px]'),
    children: jsx('canvas', {
      ref: canvasRef,
      className: 'block w-full h-full rounded-md border border-[var(--ui-stroke-secondary)]',
    }),
  })
}

function OfficeLegend({ entries }) {
  const items = useMemo(() => entries || [], [entries])
  const children = items.map((e) => {
    const c = profileColor(e.profile) || '#888'
    const label = e.busy ? 'busy' : e.online ? 'idle' : 'offline'
    return jsxs('div', {
      className: 'flex items-center gap-1.5 px-2 py-1 rounded-md border border-[var(--ui-stroke-secondary)] bg-[var(--ui-bg)]',
      children: [
        jsx('span', {
          className: 'inline-block h-2 w-2 rounded-full',
          style: { backgroundColor: c },
        }),
        jsx('span', {
          className: 'text-[var(--ui-text-secondary)]',
          children: e.profile,
        }),
        jsx('span', {
          className: 'text-[var(--ui-text-tertiary)]',
          children: '· ' + label + (e.busy ? ' (' + (e.active_agents | 0) + ')' : ''),
        }),
      ],
    }, e.profile)
  })
  return jsx('div', {
    className: 'flex flex-wrap gap-2 text-xs',
    children,
  })
}

function OfficeStats({ entries }) {
  const stats = useMemo(() => {
    const list = Array.isArray(entries) ? entries : []
    let online = 0, busy = 0, sessions = 0, tokens = 0, cost = 0, agents = 0
    for (const e of list) {
      if (!e || typeof e !== 'object') continue
      if (e.online) online++
      if (e.busy) busy++
      sessions += Number(e.active_sessions) || 0
      tokens += Number(e.tokens_total) || 0
      cost += Number(e.cost_total) || 0
      agents += Number(e.active_agents) || 0
    }
    return { online, busy, sessions, tokens, cost, agents }
  }, [entries])

  const chip = (value, label, valColor, key) => jsxs('div', {
    className: 'flex items-baseline gap-1.5 px-2.5 py-1 rounded-md border border-[var(--ui-stroke-secondary)] bg-[var(--ui-bg)]',
    children: [
      jsx('span', {
        className: 'text-sm font-semibold tabular-nums',
        style: valColor ? { color: valColor } : undefined,
        children: value,
      }),
      jsx('span', {
        className: 'text-xs text-[var(--ui-text-tertiary)]',
        children: label,
      }),
    ],
  }, key)

  const chips = [
    chip(String(stats.online), 'online', 'var(--ui-accent)', 'online'),
    chip(String(stats.busy), 'busy', stats.busy > 0 ? '#39ff88' : undefined, 'busy'),
    chip(String(stats.sessions), 'active sessions', undefined, 'sessions'),
    chip(formatCompact(stats.tokens), 'tokens', undefined, 'tokens'),
    chip(String(stats.agents), 'agents', undefined, 'agents'),
  ]
  if (stats.cost > 0) {
    chips.push(chip('$' + stats.cost.toFixed(2), 'cost', '#ffd479', 'cost'))
  }

  return jsx('div', {
    className: 'flex flex-wrap gap-2',
    children: chips,
  })
}

function OfficePage({ ctx }) {
  const query = useQuery({
    queryKey: ['office-3d', 'state'],
    queryFn: () => ctx.rest('/state'),
    refetchInterval: 5000,
  })

  let body
  if (query.isLoading) {
    body = jsx('div', {
      className: 'w-full h-[420px]',
      children: jsx(Skeleton, { className: 'w-full h-full rounded-md' }),
    })
  } else if (query.isError) {
    body = jsx(ErrorState, {
      title: 'Could not load office state',
      description: String(query.error && query.error.message ? query.error.message : query.error || 'unknown error'),
    })
  } else {
    const entries = Array.isArray(query.data) ? query.data : []
    if (entries.length === 0) {
      body = jsx(EmptyState, {
        title: 'No profiles found',
        description: 'gateway_state.json was not readable for any profile.',
      })
    } else {
      body = jsxs('div', {
        className: 'flex flex-col gap-3 w-full h-full',
        children: [
          jsx('div', {
            className: 'flex-1 min-h-[420px]',
            children: jsx(OfficeCanvas, { entries }),
          }),
          jsx(OfficeStats, { entries }),
          jsx(OfficeLegend, { entries }),
        ],
      })
    }
  }

  return jsx('div', {
    className: 'flex flex-col gap-3 p-4 w-full h-full',
    children: [
      jsxs('div', {
        className: 'flex items-baseline justify-between',
        children: [
          jsx('h1', {
            className: 'text-lg font-semibold text-[var(--ui-text-secondary)]',
            children: 'Office 3D',
          }),
          jsx('span', {
            className: 'text-xs text-[var(--ui-text-tertiary)]',
            children: 'Isometric 2D · refreshes every 5s',
          }),
        ],
      }),
      body,
    ],
  })
}

// ---------------------------------------------------------------------------
// Plugin registration.
// ---------------------------------------------------------------------------
export default {
  id: 'office-3d',
  name: 'Office 3D',
  defaultEnabled: true,
  register(c) {
    const ctx = c
    c.register({
      id: 'page',
      area: ROUTES_AREA,
      data: { path: '/office-3d' },
      render: () => jsx(OfficePage, { ctx }),
    })
    c.register({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      data: { path: '/office-3d', label: 'Office', codicon: 'home' },
    })
  },
}