// desktop/plugin.js — source of the office-3d desktop half. The Desktop app
// copies this file into ~/.hermes/desktop-plugins/office-3d/plugin.js at install.
//
// Office 3D — fake-isometric office view of the Hermes profile gateways.
// Each profile owns a desk in the WORK zone; when busy (a session is active)
// the avatar sits at the desk and its hands "type". Online-but-idle avatars
// relax in the LOUNGE zone with tea. Offline profiles are NOT drawn at all:
// their desk sits empty with a dark monitor and a dimmed name label.
//
// Rendering: 2D canvas with an isometric projection. The disk-plugin
// import whitelist forbids three.js / WebGL; only @hermes/plugin-sdk,
// react, and react/jsx-runtime may be imported. No JSX syntax.

import {
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  PALETTE_AREA,
  KEYBINDS_AREA,
  host,
  atom,
  useValue,
  useQuery,
  profileColor,
  cn,
  EmptyState,
  ErrorState,
  Skeleton,
  ListRow,
  ToggleRow,
  SegmentedControl,
  Tip,
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useMemo, useRef, useState } from 'react'

// Route of the office page, shared by the sidebar row, the palette command and
// the status-bar chip so they can never drift apart.
const OFFICE_PATH = '/office-3d'
// One React Query key for every consumer, so the chip and the page share a
// single poll instead of each starting its own.
const OFFICE_QUERY_KEY = ['office-3d', 'state']

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
  // Accept rgb()/rgba() as well as #hex. The palette mixes both — e.g. a sofa
  // base of `shade(accent, -0.4)` is an "rgb(...)" string — and when this only
  // understood #hex the whole shading chain silently no-op'd, leaving the object
  // painted in ONE flat colour (the sofa read as a plain slab for exactly this
  // reason: every face of it ended up the same rgb()).
  if (h[0] !== '#') {
    const m = /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/i.exec(h)
    if (!m) return null
    const r = Math.round(parseFloat(m[1]))
    const g = Math.round(parseFloat(m[2]))
    const b = Math.round(parseFloat(m[3]))
    if ([r, g, b].some((v) => Number.isNaN(v))) return null
    return { r, g, b }
  }
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

// ---------------------------------------------------------------------------
// Volumetric figure helpers.
//
// The avatars used to be a hard-edged iso box (torso) plus a FLAT solid circle
// (head) with two detached circles for hands — no shading, no face, no limbs —
// which reads as a cheap toy. The disk-plugin import whitelist forbids
// three.js / WebGL, so canvas-2D shading IS the ceiling; these helpers push the
// figures as close to "real" as that ceiling allows:
//   softShadow   — a radial-gradient contact shadow that grounds the figure
//   fillEllipse  — an ellipse fill (solid colour or gradient) in screen space
//   drawCylinder — a vertical iso cylinder lit from the upper-left
//   drawLimb     — a round-capped, highlighted arm/leg segment
//   drawHead     — a shaded sphere with hair (cap + hairline) and a face
// Body parts are drawn in screen px; the helpers take the frame transform so
// callers keep working in world coordinates.
// ---------------------------------------------------------------------------

// World (x, y, z) -> absolute screen point for the frame's transform.
function screenPt(ox, oy, x, y, z, scale) {
  const [px, py] = iso(x, y, z, scale)
  return [ox + px, oy + py]
}

function fillEllipse(c, cx, cy, rx, ry, style) {
  if (!(rx > 0)) return
  c.save()
  c.translate(cx, cy)
  c.scale(1, ry / rx)
  c.beginPath()
  c.arc(0, 0, rx, 0, Math.PI * 2)
  c.restore()
  c.fillStyle = style
  c.fill()
}

// Soft elliptical contact shadow on the ground under a figure — the single
// cheapest cue that a body is standing on the floor rather than floating.
function softShadow(c, ox, oy, x, y, rWorld, scale, ink, aMax) {
  const [cx, cy] = screenPt(ox, oy, x, y, 0.012, scale)
  const rx = rWorld * scale
  if (!(rx > 0.5)) return
  const ry = rx * (ISO_Y / ISO_X)
  const rgb = hexToRgb(ink) || { r: 0, g: 0, b: 0 }
  const col = (a) => 'rgba(' + rgb.r + ', ' + rgb.g + ', ' + rgb.b + ', ' + a + ')'
  const g = c.createRadialGradient(cx, cy, 0, cx, cy, rx)
  g.addColorStop(0, col(aMax))
  g.addColorStop(0.55, col(aMax * 0.5))
  g.addColorStop(1, col(0))
  c.save()
  c.translate(cx, cy)
  c.scale(1, ry / rx)
  c.beginPath()
  c.arc(0, 0, rx, 0, Math.PI * 2)
  c.restore()
  c.fillStyle = g
  c.fill()
}

// Vertical cylinder from z0 (bottom) to z1 (top), centred on (x, y). Rounded
// caps + a left-lit side wall read as a limb/torso, unlike a hard box.
function drawCylinder(c, ox, oy, x, y, z0, z1, r, scale, base) {
  const rx = r * scale
  if (!(rx > 0.4)) return
  const [cx, yTop] = screenPt(ox, oy, x, y, z1, scale)
  const [, yBot] = screenPt(ox, oy, x, y, z0, scale)
  const ry = rx * (ISO_Y / ISO_X)
  // Bottom cap (in shadow) — its front half peeks below the body.
  fillEllipse(c, cx, yBot, rx, ry, shade(base, -0.34))
  // Side wall: highlight band just left of centre, deep shadow on the right.
  const g = c.createLinearGradient(cx - rx, 0, cx + rx, 0)
  g.addColorStop(0.0, shade(base, -0.20))
  g.addColorStop(0.28, shade(base, 0.20))
  g.addColorStop(0.60, shade(base, 0.0))
  g.addColorStop(1.0, shade(base, -0.42))
  c.fillStyle = g
  c.fillRect(cx - rx, yTop, rx * 2, Math.max(0, yBot - yTop))
  // Top cap: rim-lit like a surface facing the light.
  const gt = c.createLinearGradient(cx - rx, yTop - ry, cx + rx, yTop + ry)
  gt.addColorStop(0, shade(base, 0.34))
  gt.addColorStop(1, shade(base, 0.02))
  fillEllipse(c, cx, yTop, rx, ry, gt)
}

// An isometric box with per-face GRADIENTS and only the lit top-front edges
// highlighted, instead of flat fills plus a hard 1px outline all the way round —
// that outline is what made the furniture read as a wireframe toy. Light comes
// from the upper-left, as everywhere else in this scene.
function drawIsoBoxSoft(c, ox, oy, x, y, z, w, d, h, scale, base, opts) {
  const o = opts || {}
  const [tlx, tly] = iso(x, y, z + h, scale)
  const [trx, trY] = iso(x + w, y, z + h, scale)
  const [brx, bry] = iso(x + w, y + d, z + h, scale)
  const [blx, bly] = iso(x, y + d, z + h, scale)
  const [tblx, tbly] = iso(x, y + d, z, scale)
  const [tbrx, tbry] = iso(x + w, y + d, z, scale)
  const [tfrx, tfry] = iso(x + w, y, z, scale)
  const ax = (v) => ox + v

  // Right face (+x): brightest along its top edge, falling off toward the floor.
  const gr = c.createLinearGradient(0, oy + trY, 0, oy + tbry)
  gr.addColorStop(0, shade(base, -0.12))
  gr.addColorStop(1, shade(base, -0.44))
  c.beginPath()
  c.moveTo(ax(trx), oy + trY)
  c.lineTo(ax(brx), oy + bry)
  c.lineTo(ax(tbrx), oy + tbry)
  c.lineTo(ax(tfrx), oy + tfry)
  c.closePath()
  c.fillStyle = gr
  c.fill()

  // Left face (+y): the shaded side, darkest at the bottom.
  const gl = c.createLinearGradient(0, oy + bly, 0, oy + tbly)
  gl.addColorStop(0, shade(base, -0.36))
  gl.addColorStop(1, shade(base, -0.06))
  c.beginPath()
  c.moveTo(ax(brx), oy + bry)
  c.lineTo(ax(blx), oy + bly)
  c.lineTo(ax(tblx), oy + tbly)
  c.lineTo(ax(tbrx), oy + tbry)
  c.closePath()
  c.fillStyle = gl
  c.fill()

  // Top face: lit from the far corner, easing off toward the viewer.
  const lift = o.top == null ? 0.26 : o.top
  const gt = c.createLinearGradient(ax(tlx), oy + tly, ax(brx), oy + bry)
  gt.addColorStop(0, shade(base, lift))
  gt.addColorStop(1, shade(base, lift - 0.20))
  c.beginPath()
  c.moveTo(ax(tlx), oy + tly)
  c.lineTo(ax(trx), oy + trY)
  c.lineTo(ax(brx), oy + bry)
  c.lineTo(ax(blx), oy + bly)
  c.closePath()
  c.fillStyle = gt
  c.fill()

  // Edge light on the two top-front edges only — the rim a real object catches
  // from above, rather than an outline everywhere.
  if (o.edge !== false) {
    c.save()
    c.strokeStyle = 'rgba(255, 255, 255, ' +
      (o.edgeAlpha == null ? 0.12 : o.edgeAlpha) + ')'
    c.lineWidth = 1
    c.beginPath()
    c.moveTo(ax(tlx), oy + tly)
    c.lineTo(ax(trx), oy + trY)
    c.lineTo(ax(brx), oy + bry)
    c.stroke()
    c.restore()
  }
}

// A horizontal disc with a radial gradient: cushion tops, plinths, tabletops.
function drawIsoDiscSoft(c, ox, oy, x, y, z, radius, scale, base, opts) {
  const o = opts || {}
  const [cx, cy] = screenPt(ox, oy, x, y, z, scale)
  const rx = radius * scale
  if (!(rx > 0.4)) return
  const ry = rx * (ISO_Y / ISO_X)
  const lift = o.top == null ? 0.22 : o.top
  const g = c.createRadialGradient(
    cx - rx * 0.30, cy - ry * 0.30, rx * 0.10,
    cx, cy, rx,
  )
  g.addColorStop(0, shade(base, lift))
  g.addColorStop(1, shade(base, -0.20))
  fillEllipse(c, cx, cy, rx, ry, g)
}

// A limb segment (arm/leg): round-capped stroke plus a thin lit highlight so
// the stroke reads as a cylinder rather than a flat ribbon. `bend` nudges the
// control point (px) to suggest an elbow/knee.
function drawLimb(c, p0, p1, width, base, bend) {
  if (!(width > 0.5)) return
  const [x0, y0] = p0
  const [x1, y1] = p1
  const bx = bend ? bend[0] : 0
  const by = bend ? bend[1] : 0
  const mx = (x0 + x1) / 2 + bx
  const my = (y0 + y1) / 2 + by
  c.save()
  c.lineCap = 'round'
  c.lineJoin = 'round'
  c.strokeStyle = shade(base, -0.14)
  c.lineWidth = width
  c.beginPath()
  c.moveTo(x0, y0)
  c.quadraticCurveTo(mx, my, x1, y1)
  c.stroke()
  const off = width * 0.20
  c.strokeStyle = shade(base, 0.18)
  c.lineWidth = Math.max(1, width * 0.32)
  c.beginPath()
  c.moveTo(x0 - off, y0 - off)
  c.quadraticCurveTo(mx - off, my - off, x1 - off, y1 - off)
  c.stroke()
  c.restore()
}

// A shaded head: a radial-gradient sphere with the hair cut away around a face
// oval, plus (only once the head is a few px across) eyes, catch-lights and a
// mouth. `blink` in [0,1] squashes the eyes shut.
//
// `facing` is the SCREEN-space direction the face points along, because the two
// poses look in genuinely different directions:
//   [0.19, 0.98]  — nearly straight down = out at the viewer. The lounge sitter
//                   relaxes facing the room, so we see the face.
//   [0.82, -0.58] — up-right = along -y in world = at the desk. The sitter works
//                   facing the monitor, so we see the BACK of the head: the hair
//                   stays a full cap and only a sliver of cheek shows. (The
//                   viewer looks from screen-down, so "up-right" is away.)
// Facial features are only drawn when the face is turned toward the viewer;
// that single gate is what makes each pose read correctly.
// Head facing per pose, in SCREEN space (see drawHead). A unit step along world
// -y projects to (0.816, -0.577) — right and up — so the desk sitter, who faces
// the monitor, is seen from behind. The lounge sitter faces out at the viewer.
const DESK_FACING = [0.816, -0.577]
const LOUNGE_FACING = [0.19, 0.98]
const FACE_TV_MIN = 0.45

function drawHead(c, cx, cy, r, opts) {
  if (!(r > 0.6)) return
  const skin = opts.skin
  const skinShadow = opts.skinShadow || shade(skin, -0.3)
  const hair = opts.hair
  const hairLit = opts.hairLit || shade(hair, 0.25)

  let fdx = opts.facing ? opts.facing[0] : 0.19
  let fdy = opts.facing ? opts.facing[1] : 0.98
  const flen = Math.hypot(fdx, fdy) || 1
  fdx /= flen
  fdy /= flen
  const tv = fdy // +1 == looking straight at the viewer (screen down)
  const wantFace = opts.face !== false
  const showFace = wantFace && tv > FACE_TV_MIN

  // ONE gradient shared by the skull and the face cut-out, so the shading runs
  // continuously across the hairline instead of showing a seam.
  const g = c.createRadialGradient(
    cx - r * 0.34, cy - r * 0.42, r * 0.10,
    cx, cy, r * 1.08,
  )
  g.addColorStop(0.0, shade(skin, 0.34))
  g.addColorStop(0.50, skin)
  g.addColorStop(0.86, shade(skin, -0.14))
  g.addColorStop(1.0, shade(skinShadow, -0.08))

  // 1. Skull.
  c.beginPath()
  c.arc(cx, cy, r, 0, Math.PI * 2)
  c.fillStyle = g
  c.fill()

  // 2. Hair covers the WHOLE skull, then the face is CUT BACK OUT of it.
  //    Do NOT paint hair as a big disc and then draw the face on top: the disc's
  //    lower edge bows down through the middle of the head, so the "hairline"
  //    lands below the eyes and mouth — and since the features are painted last
  //    they end up sitting ON the hair. Here the hairline is an edge of the
  //    HAIR (the top of the face cut-out), which is what actually reads as hair.
  c.save()
  c.beginPath()
  c.arc(cx, cy, r, 0, Math.PI * 2)
  c.clip()
  const hg = c.createLinearGradient(cx - r, cy - r, cx + r, cy + r)
  hg.addColorStop(0, hairLit)
  hg.addColorStop(1, hair)
  c.fillStyle = hg
  c.fillRect(cx - r, cy - r, r * 2, r * 2)

  // 3. Face cut-out, slid along the facing direction. Turning away pushes the
  //    oval out until only a crescent of cheek is left at the far edge, which is
  //    exactly the "back of the head" cue.
  const ovalOut = r * (0.37 + Math.max(0, FACE_TV_MIN - tv) * 1.15)
  fillEllipse(c, cx + fdx * ovalOut, cy + fdy * ovalOut, r * 0.80, r * 0.78, g)
  c.restore()

  if (r < 7 || !wantFace) return // too small to carry features either way

  if (!showFace) {
    // Back / far side of the head: one visible ear keeps it from reading as a
    // featureless ball. The ears sit on the axis perpendicular to the facing.
    fillEllipse(c, cx - fdy * r * 0.78, cy + fdx * r * 0.78, r * 0.19, r * 0.23,
      shade(skin, -0.04))
    return
  }

  // 4. Features. The head stays UPRIGHT, so the eye row is screen-horizontal and
  //    merely foreshortens as the face turns; the mouth sits straight below it.
  const blink = opts.blink == null ? 1 : opts.blink
  const eyeCX = cx + fdx * r * 0.26
  const eyeCY = cy + fdy * r * 0.26
  const halfSep = r * 0.29 * Math.min(1, Math.abs(tv))
  const eyeRx = r * 0.110
  const eyeRy = Math.max(0.7, r * 0.145 * blink)
  const eyeColor = opts.eyeColor || '#1f242c'
  const drawEye = (ex) => {
    fillEllipse(c, ex, eyeCY, eyeRx, eyeRy, eyeColor)
    if (eyeRy > r * 0.10) {
      fillEllipse(c, ex + eyeRx * 0.34, eyeCY - eyeRy * 0.42,
        eyeRx * 0.32, eyeRy * 0.34, 'rgba(255, 255, 255, 0.88)')
    }
  }
  drawEye(eyeCX - halfSep)
  drawEye(eyeCX + halfSep)
  // Mouth: a small upward-bowed arc (a relaxed smile).
  c.strokeStyle = shade(skinShadow, -0.30)
  c.lineWidth = Math.max(1, r * 0.05)
  c.lineCap = 'round'
  c.beginPath()
  c.arc(eyeCX, eyeCY + r * 0.42, r * 0.19, 0.24 * Math.PI, 0.76 * Math.PI)
  c.stroke()
}

// ---------------------------------------------------------------------------
// Scene layout.
//
// The desk grid is DERIVED from the number of profiles: a fixed 3-column grid
// pushed the 7th desk outside the work floor (y=6.9 > the 6.5-deep floor), so
// the office overflowed as soon as an install had more than six profiles.
// Everything here is pure — no canvas, no DOM — so it can be unit-tested.
// ---------------------------------------------------------------------------
const DESK_ROW_SPACING = 3.2
const DESK_COL_SPACING = 3.6
const WORK_ORIGIN = { x: 0.5, y: 0.5 }
// Floor margin around the desk grid. 3.3 reproduces the original 6.5-deep work
// floor for a two-row grid, so a six-profile install looks exactly as before.
const WORK_PAD = 3.3
const LOUNGE_DEPTH = 6.0 // lounge zone depth (its furniture is a fixed size)
const LOUNGE_GAP = 0.5   // gap between the work floor and the lounge floor
const LOUNGE_W = 11      // minimum scene width, so the lounge ring always fits
// The lounge GROUP — ring of stools + coffee table + sofa — is a fixed size. Its
// own bounding box, measured from the anchor sceneLayout hands out, spans
// x [-0.3, +3.8] and y [-0.1, +4.55], so its centre sits at these offsets.
// sceneLayout therefore anchors the group at the ZONE's centre instead of at the
// work floor's left edge: pinning it left crammed the whole group into the first
// third of an 11-wide zone and left the rest of the floor empty.
const LOUNGE_GROUP_CX = 2.05
const LOUNGE_GROUP_CY = 2.225
const MAX_COLS = 5       // widest desk grid
const MIN_SCALE = 10     // smallest scene scale that still fits a huge install
const MAX_SCALE = 64

// ---------------------------------------------------------------------------
// View transform (zoom + pan).
//
// `zoom` is a MULTIPLIER on the fit-to-canvas scale, so 1 = "fit the whole
// office" and the default look is byte-identical to before this feature. The
// transform is a pure function of (canvas size, layout, zoom, pan) precisely so
// the wheel/pan handlers and drawFrame can never disagree about where a desk
// landed — a click is hit-tested against the very transform the pixels came
// from (drawFrame hands it back).
// ---------------------------------------------------------------------------
const VIEW_ZOOM_MIN = 0.4
const VIEW_ZOOM_MAX = 6

function clampZoom(z) {
  if (!Number.isFinite(z)) return 1
  return Math.max(VIEW_ZOOM_MIN, Math.min(VIEW_ZOOM_MAX, z))
}

function frameTransform(cssW, cssH, L, zoom, panX, panY) {
  const margin = 24
  const sceneH = Math.max(120, cssH)
  const scaleFit = Math.min(
    (cssW - margin * 2) / L.projW,
    (sceneH - margin * 2) / L.projH,
  )
  // Clamp the FIT to a sane band (a 40-profile install must not vanish, a tiny
  // one must not fill the screen), then let the user's zoom multiply it freely.
  const base = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scaleFit))
  const z = clampZoom(zoom)
  const scale = base * z
  const leftMost = (0 - L.worldH) * ISO_X * scale
  const topMost = -3.0 * scale
  const px = Number.isFinite(panX) ? panX : 0
  const py = Number.isFinite(panY) ? panY : 0
  const ox = margin - leftMost +
    Math.max(0, (cssW - margin * 2 - L.projW * scale) / 2) + px
  const oy = margin - topMost + py
  return { ox, oy, scale, fit: scaleFit, zoom: z }
}

// Zoom to `nextZoom` while keeping the world point under (ax, ay) pinned to
// that screen position — the standard "zoom at the cursor" feel. Both the
// before and after transforms come from frameTransform, so the anchoring is
// exact rather than approximate.
function zoomAbout(cssW, cssH, L, view, nextZoom, ax, ay) {
  const before = frameTransform(cssW, cssH, L, view.zoom, view.panX, view.panY)
  const nx = clampZoom(nextZoom)
  const base = frameTransform(cssW, cssH, L, nx, 0, 0)
  const k = before.scale === 0 ? 1 : base.scale / before.scale
  const cx = Number.isFinite(ax) ? ax : cssW / 2
  const cy = Number.isFinite(ay) ? ay : cssH / 2
  return {
    zoom: nx,
    panX: cx - (cx - before.ox) * k - base.ox,
    panY: cy - (cy - before.oy) * k - base.oy,
  }
}

// Near-square desk grid for `count` desks: 6 -> 3x2 (unchanged), 9 -> 3x3,
// 12 -> 4x3, 25 -> 5x5.
function deskGrid(count) {
  const n = Math.max(1, Math.floor(count) || 1)
  let cols = Math.max(2, Math.min(MAX_COLS, Math.ceil(Math.sqrt(n))))
  if (cols > n) cols = n
  return { cols, rows: Math.ceil(n / cols) }
}

// World-space extents of the whole scene for `count` desks, plus the isometric
// bounding box used to fit it into the canvas.
function sceneLayout(count) {
  const { cols, rows } = deskGrid(count)
  const workW = (cols - 1) * DESK_COL_SPACING + WORK_PAD
  const workH = (rows - 1) * DESK_ROW_SPACING + WORK_PAD
  const worldW = Math.max(LOUNGE_W, workW)
  const loungeY0 = workH + LOUNGE_GAP
  const worldH = loungeY0 + LOUNGE_DEPTH
  // Ground plane projects to (w + h) * ISO_X wide and (w + h) * ISO_Y tall;
  // add the z extent above it (monitors + name labels sit at z ≈ 2.1-3.0).
  return {
    cols,
    rows,
    workW,
    workH,
    worldW,
    worldH,
    loungeY0,
    projW: (worldW + worldH) * ISO_X,
    projH: (worldW + worldH) * ISO_Y + 3.0,
    // Lounge furniture is anchored so the GROUP is centred in the lounge zone
    // (see LOUNGE_GROUP_C*), instead of hanging off the work floor's left edge.
    lounge: {
      x: worldW / 2 - LOUNGE_GROUP_CX,
      y: loungeY0 + LOUNGE_DEPTH / 2 - LOUNGE_GROUP_CY,
    },
  }
}

function deskSlot(index, cols) {
  const col = index % cols
  const row = Math.floor(index / cols)
  return {
    x: WORK_ORIGIN.x + col * DESK_COL_SPACING,
    y: WORK_ORIGIN.y + row * DESK_ROW_SPACING,
  }
}

function loungeSlot(index, total, lounge) {
  const t = total > 0 ? total : 1
  const angle = (index / t) * Math.PI * 2
  const r = 1.7
  return {
    x: lounge.x + 2.0 + Math.cos(angle) * r,
    y: lounge.y + 1.6 + Math.sin(angle) * r,
  }
}

// ---------------------------------------------------------------------------
// Hit testing.
//
// A desk is clickable, so the click handler needs the inverse of the frame
// projection. drawFrame hands back the transform it drew with (ox/oy/scale +
// the layout), and these helpers turn a CSS-pixel point back into a desk index.
// Pure functions — no canvas, no DOM — so they are unit-testable.
// ---------------------------------------------------------------------------
const DESK_W = 2.2        // desk footprint (x)
const DESK_D = 1.1        // desk footprint (y)
const DESK_H = 1.6        // desk + monitor + name label, for the click target

// Screen-space (CSS px) bounding box of one desk's clickable volume.
function deskHitBox(slot, ox, oy, scale) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const dx of [0, DESK_W]) {
    for (const dy of [0, DESK_D]) {
      for (const dz of [0, DESK_H]) {
        const [px, py] = iso(slot.x + dx, slot.y + dy, dz, scale)
        const sx = ox + px
        const sy = oy + py
        if (sx < x0) x0 = sx
        if (sx > x1) x1 = sx
        if (sy < y0) y0 = sy
        if (sy > y1) y1 = sy
      }
    }
  }
  return { x0, y0, x1, y1 }
}

// Which desk is under (px, py) in CSS px? Boxes overlap in an isometric scene,
// so among the hits pick the FRONT-most one (largest slot.x + slot.y, the order
// drawFrame paints in), which is the desk the user actually sees on top.
function hitTestDesks(entries, frame, px, py) {
  if (!frame || !Array.isArray(entries)) return -1
  const { ox, oy, scale, layout } = frame
  let bestIndex = -1
  let bestDepth = -Infinity
  for (let i = 0; i < entries.length; i++) {
    const slot = deskSlot(i, layout.cols)
    const box = deskHitBox(slot, ox, oy, scale)
    if (px < box.x0 || px > box.x1 || py < box.y0 || py > box.y1) continue
    const depth = slot.x + slot.y
    if (depth > bestDepth) {
      bestDepth = depth
      bestIndex = i
    }
  }
  return bestIndex
}

// ---------------------------------------------------------------------------
// Palette that FOLLOWS the Hermes global theme. buildPalette reads the app's
// --ui-bg each frame and picks a light or dark scene palette from its
// luminance, so toggling Hermes's theme flips the office automatically.
// getComputedStyle also supplies the accent color.
// ---------------------------------------------------------------------------
function buildPalette(canvas) {
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
      chairBackTop: '#cfd4dc',
      chairPost: '#9aa1ab',
      chairBase: '#aeb4be',
      monitorShell: '#c6cbd3',
      keyboard: '#b6bcc6',
      deskWood: '#c9a876',
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
      // Figure tones (skin/hair/trousers are neutral so the profile-colored
      // clothes still carry identity; only the person is ever profile-hued).
      skin: '#f2c69d',
      skinShadow: '#cf9a63',
      hair: '#3b2c22',
      hairLit: '#5b4433',
      trouser: '#7d879a',
      shoe: '#40464f',
      shadowInk: '#232a36',
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
    chairBackTop: '#43484e',
    chairPost: '#22262b',
    chairBase: '#2a2f36',
    monitorShell: '#2f353d',
    keyboard: '#3c434c',
    deskWood: '#9c7a52',
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
    // Figure tones — see the light-mode note above.
    skin: '#e9b98f',
    skinShadow: '#a9713f',
    hair: '#241d1a',
    hairLit: '#3f342a',
    trouser: '#39414e',
    shoe: '#22262c',
    shadowInk: '#000000',
  }
}

// Accent outline on the floor under the SELECTED desk, so a click has visible
// feedback. Drawn before the desks so it reads as a mat, not a box.
function drawSelection(c, ox, oy, scale, slot, accent) {
  const pad = 0.28
  const corners = [
    [slot.x - pad, slot.y - pad],
    [slot.x + DESK_W + pad, slot.y - pad],
    [slot.x + DESK_W + pad, slot.y + DESK_D + pad],
    [slot.x - pad, slot.y + DESK_D + pad],
  ]
  c.save()
  c.beginPath()
  corners.forEach(([x, y], i) => {
    const [px, py] = iso(x, y, 0.02, scale)
    if (i === 0) c.moveTo(ox + px, oy + py)
    else c.lineTo(ox + px, oy + py)
  })
  c.closePath()
  // Never parse the accent (it can be an oklch()/color-mix() expression the
  // canvas will not accept) — modulate alpha on the color itself.
  c.globalAlpha = 0.16
  c.fillStyle = accent
  c.fill()
  c.globalAlpha = 0.9
  c.strokeStyle = accent
  c.lineWidth = 2.5
  c.stroke()
  c.restore()
}

// ---------------------------------------------------------------------------
// Frame draw.
// ---------------------------------------------------------------------------
function drawFrame(canvas, c, entries, tSec, selectedIndex, view) {
  if (!Array.isArray(entries)) entries = []
  const P = buildPalette(canvas)
  const bg = P.bg
  const stroke = P.stroke
  const textSec = P.textSec
  const textTer = P.textTer
  const textQuat = P.textQuat
  const accent = P.accent

  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
  const cssW = canvas.clientWidth || 640
  const cssH = canvas.clientHeight || 400

  c.setTransform(1, 0, 0, 1, 0, 0)
  c.clearRect(0, 0, canvas.width, canvas.height)
  c.scale(dpr, dpr)

  // Background
  c.fillStyle = bg
  c.fillRect(0, 0, cssW, cssH)

  // Size the scene for THIS many desks, then fit it (and apply the user's zoom +
  // pan) into the canvas. frameTransform is pure so the wheel handler computes
  // the identical transform.
  const L = sceneLayout(Array.isArray(entries) ? entries.length : 0)
  const T = frameTransform(
    cssW,
    cssH,
    L,
    view ? view.zoom : 1,
    view ? view.panX : 0,
    view ? view.panY : 0,
  )
  const ox = T.ox
  const oy = T.oy
  const scale = T.scale

  // Zone floors
  drawFloor(c, ox, oy, 0, 0, L.worldW, L.workH, scale, {
    fill: P.floorWorkFill,
    stroke,
  })
  drawFloor(c, ox, oy, 0, L.loungeY0, L.worldW, LOUNGE_DEPTH, scale, {
    fill: P.floorLoungeFill,
    stroke,
  })

  // Zone labels — bottom-right corner of each zone.
  c.font = '10px system-ui, -apple-system, "Segoe UI", sans-serif'
  c.fillStyle = textTer
  c.textAlign = 'right'
  {
    const [lx, ly] = iso(L.worldW, L.workH, 0, scale)
    c.fillText('WORK', ox + lx + 24, oy + ly - 22)
  }
  {
    const [lx, ly] = iso(L.worldW, L.loungeY0 + LOUNGE_DEPTH, 0, scale)
    c.fillText('LOUNGE', ox + lx + 24, oy + ly - 22)
  }
  c.textAlign = 'start'

  // Selection mat under the clicked desk (before the desks, so it is not on top).
  if (
    typeof selectedIndex === 'number' &&
    selectedIndex >= 0 &&
    selectedIndex < entries.length
  ) {
    drawSelection(c, ox, oy, scale, deskSlot(selectedIndex, L.cols), accent)
  }

  // Lounge furniture (drawn behind lounge avatars because sofa is at higher y).
  drawLounge(c, ox, oy, scale, stroke, textQuat, accent, tSec, P, L.lounge)

  // Desks & at-desk avatars — painter's order, back to front.
  const desks = entries.map((entry, i) => ({ entry, i, slot: deskSlot(i, L.cols) }))
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
    const slot = loungeSlot(idx, lounged.length, L.lounge)
    drawLoungeAvatar(c, ox, oy, scale, slot, entry, i, tSec, idx,
      { stroke, textSec, textTer, accent, P })
  })

  // -------------------------------------------------------------------------
  // (Aggregate stats now render as DOM chips below the canvas — see
  // OfficeStats — not painted here, so the canvas stays a clean scene.)
  // -------------------------------------------------------------------------

  // Hand the transform back so a click can be hit-tested against exactly the
  // projection these pixels were drawn with (zoom + pan included).
  return { ox, oy, scale, zoom: T.zoom, layout: L }
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

// Lounge furniture footprint, in ONE place: drawLounge draws from these numbers
// and the test harness asserts on them (the group has to stay inside the zone
// and must not collide with the ring of stools).
function loungeLayout(lounge) {
  return {
    sx: lounge.x + 0.6,          // sofa
    sy: lounge.y + 3.55,         // 3.55 clears the stool ring's south slot
    sofaW: 3.2,
    sofaD: 1.0,
    tx: lounge.x + 1.1,          // coffee table
    ty: lounge.y + 0.9,
    tw: 2.0,
    td: 1.0,
  }
}

// World-space upholstery dimensions. Screen-top extrema at different x/y are
// NOT a height constraint: the far arm naturally projects above the near back.
function sofaDims() {
  const seatZ = 0.45
  const legH = 0.12
  return {
    armW: 0.28,
    legH,
    seatZ,
    backTop: seatZ + 0.57,   // normal back, not a screen-bbox-driven high wall
    armTop: seatZ + 0.25,
  }
}

// The sofa, in its own function so a diagnostic can draw each part in a distinct
// colour. The back stays on LARGE y, facing the coffee table at smaller y.
// Paint far (-x) arm, seat/seams, near (+y) back, then near (+x) arm.
// The rear upholstery is a single panel, not the inside cushion divisions.
function drawSofa(c, ox, oy, scale, P, LL, tint) {
  const t = tint || {}
  const sofa = t.sofa || (P.mode === 'light' ? '#b9c2cf' : shade(P.accent, -0.4))
  const backInk = t.back || shade(sofa, -0.26)
  const armInk = t.arm || shade(sofa, -0.06)
  const legInk = t.leg || shade(sofa, -0.48)
  const seamInk = t.seam || shade(sofa, -0.52)
  const sx = LL.sx
  const sy = LL.sy
  const sofaW = LL.sofaW
  const sofaD = LL.sofaD
  const D = sofaDims()
  const armW = D.armW
  const legH = D.legH
  const seatZ = D.seatZ
  const backTop = D.backTop
  const armTop = D.armTop
  const backY = sy + sofaD - 0.22
  const backX = sx + armW
  const backW = sofaW - armW * 2
  softShadow(c, ox, oy, sx + sofaW / 2, sy + sofaD / 2, 1.95, scale,
    P.shadowInk || '#000000', 0.18)
  // Legs first, so the frame and arms paint over their tops.
  for (const fx of [0.24, sofaW - 0.24]) {
    for (const fy of [0.24, sofaD - 0.24]) {
      drawCylinder(c, ox, oy, sx + fx, sy + fy, 0, legH, 0.062, scale, legInk)
    }
  }
  // Far arm first: its rear end must disappear behind the back, not cover it.
  drawIsoBoxSoft(c, ox, oy, sx, sy, legH, armW, sofaD, armTop - legH, scale,
    t.farArm || armInk, { top: 0.16 })
  // Frame between the arms, lifted on the legs (no coincident arm surfaces).
  drawIsoBoxSoft(c, ox, oy, backX, sy, legH, backW, sofaD, seatZ - legH, scale, sofa,
    { top: 0.14 })
  // Seat divisions belong on the seat only, BEFORE the opaque backrest.
  c.save()
  c.strokeStyle = seamInk
  c.lineWidth = Math.max(1, scale * 0.013)
  const seg = (a, b) => {
    const [a0x, a0y] = iso(a[0], a[1], a[2], scale)
    const [a1x, a1y] = iso(b[0], b[1], b[2], scale)
    c.beginPath()
    c.moveTo(ox + a0x, oy + a0y)
    c.lineTo(ox + a1x, oy + a1y)
    c.stroke()
  }

  for (let i = 1; i < 3; i++) {
    const bx = backX + (backW * i) / 3
    seg([bx, sy, seatZ], [bx, backY, seatZ])
  }
  c.restore()
  // Near back masks hidden seat lines and the far arm's rear corner.
  drawIsoBoxSoft(c, ox, oy, backX, backY, seatZ, backW, 0.22, backTop - seatZ, scale,
    backInk, { top: 0.08 })
  // Near arm is the only arm that overlaps the backrest's near end.
  drawIsoBoxSoft(c, ox, oy, sx + sofaW - armW, sy, legH, armW, sofaD, armTop - legH,
    scale, t.nearArm || armInk, { top: 0.16 })
}

function drawLounge(c, ox, oy, scale, stroke, tint, accent, tSec, palette, lounge) {
  const P = palette || {}
  const isLight = P.mode === 'light'
  // Sofa fabric base: a muted blue-grey in dark, a soft light fabric in light.
  const sofa = isLight ? '#b9c2cf' : shade(accent, -0.4)
  // Coffee-table wood: deep walnut in dark, light oak in light.
  const wood = isLight ? '#c9a876' : '#6b4b2a'
  // Anchored to the lounge origin the scene layout computed, so the zone
  // follows the desk grid.
  // ---- Sofa ----
  // Geometry and comments live in drawSofa(); the footprint comes from
  // loungeLayout() so the tests can assert on the same numbers.
  drawSofa(c, ox, oy, scale, P, loungeLayout(lounge))
  // ---- Coffee table: long enough that three cups fit with a margin ----------
  const { tx, ty, tw, td } = loungeLayout(lounge)
  const legIn = 0.14
  const legs = [
    [legIn, legIn], [tw - legIn, legIn],
    [legIn, td - legIn], [tw - legIn, td - legIn],
  ]
  legs.sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]))
  for (let i = 0; i < legs.length; i++) {
    drawCylinder(c, ox, oy, tx + legs[i][0], ty + legs[i][1], 0, 0.34, 0.05, scale, wood)
  }
  const tableZ = 0.34
  const topH = 0.09
  drawIsoBoxSoft(c, ox, oy, tx, ty, tableZ, tw, td, topH, scale, wood, { top: 0.18 })

  // Teacups — 🍵 emoji, evenly spaced across the top with a margin each side and
  // centred in depth so they stand ON the table rather than over its edges.
  c.save()
  c.textAlign = 'center'
  c.textBaseline = 'alphabetic'
  const cupPx = Math.max(9, Math.round(scale * 0.30))
  c.font = cupPx + 'px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif'
  for (let i = 0; i < 3; i++) {
    const cxw = tx + tw * (i + 1) / 4
    const cyw = ty + td * 0.5
    // Tableware is stationary; only the separate hand-held cup is animated.
    const [px, py] = iso(cxw, cyw, tableZ + topH, scale)
    c.fillText('🍵', ox + px, oy + py)
  }
  c.textAlign = 'start'
  c.textBaseline = 'alphabetic'
  c.restore()
}

// Pure world-space layout of ONE workstation: desk fixtures, chair and the
// sitter's shoulders/hands. Extracted so the drawing code and the tests share
// the SAME numbers — "the hands must clear the torso" is geometry, not taste,
// and eyeballing it got it wrong twice.
function deskLayout(slot) {
  // NOTE: the sitter deliberately sits at the desk's west end while the monitor
  // and keyboard are centred a little further east. That offset is what makes the
  // hands reach forward past the body. Centring everything on the sitter instead
  // made the typing read worse — do NOT re-align these without comparing the
  // render before and after.
  const chairX = slot.x + 0.15
  const chairY = slot.y + 0.72
  const cx = chairX + 0.45
  const cy = chairY + 0.45
  const seatZ = 0.50           // hips on the cushion (its top sits at 0.48)
  const torsoH = 0.62
  const topZ = seatZ + torsoH
  const torsoR = 0.29
  // Seen from behind there is no need to show neck skin: the head sits IN the
  // collar, and a skin cylinder that size read as a third blob next to the two
  // hands. The neck stays, but it is narrow and almost entirely covered.
  const neckR = 0.10
  const neckTopZ = topZ + 0.10
  const collarR = 0.19
  const collarTopZ = topZ + 0.065
  const headR = 0.29
  const headCz = topZ + 0.05 + headR // the head's lowest point is topZ + 0.05
  const kbX = slot.x + 0.65
  const kbY = slot.y + 0.70
  const kbW = 0.80
  const kbD = 0.30
  const handZ = 0.82
  const handY = kbY + kbD * 0.5
  return {
    chairX, chairY, cx, cy, seatZ, torsoH, topZ, torsoR,
    neckR, neckTopZ, collarR, collarTopZ, headR, headCz,
    kbX, kbY, kbW, kbD, handZ, handY,
    monX: slot.x + 0.62,
    monY: slot.y + 0.14,
    panW: 0.92, panD: 0.07, panH: 0.60, panZ: 0.86,
    mugX: slot.x + 1.86,
    mugY: slot.y + 0.52,
    shoulderZ: topZ - 0.10,
    // Every SHOULDER lands inside the torso's silhouette and every HAND well
    // outside it. drawDeskAndAvatar paints both arms BEFORE the torso, so the
    // body occludes the top of each arm while both hands stay visible on the
    // keys — that ordering is the layering fix.
    shoulders: [
      [cx - 0.26, cy - 0.04, topZ - 0.10],
      [cx + 0.26, cy - 0.04, topZ - 0.10],
    ],
    hands: [
      [kbX + 0.20, handY, handZ],
      [kbX + kbW - 0.20, handY, handZ],
    ],
  }
}

// Stable identity phase: reordering profiles does not synchronise their gestures.
function posePhase(profile) {
  let h = 0
  for (const ch of String(profile || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return (h % 1009) / 1009
}
function deskPose(slot, profile, tSec) {
  const S = deskLayout(slot)
  const phase = posePhase(profile) * Math.PI * 2
  const breath = 0.006 * Math.sin(tSec * 1.35 + phase)
  const hands = S.hands.map((h, a) => [h[0] + 0.006 * Math.sin(tSec * 3 + phase + a),
    h[1], 0.817 + 0.007 * (0.5 + 0.5 * Math.sin(tSec * 7 + phase + a * 2.3))])
  const shoulders = S.shoulders.map(p => [p[0], p[1], p[2] + breath])
  const elbows = shoulders.map((p, a) => [p[0] * 0.45 + hands[a][0] * 0.55,
    p[1] * 0.48 + hands[a][1] * 0.52 + 0.035, 0.86 + breath * 0.5])
  return {S, breath, hands, shoulders, elbows, head: [S.cx, S.cy, S.headCz + breath]}
}
// Smooth rest -> lift -> sip hold -> lower -> rest; hips and feet never bob.
function loungePose(slot, profile, tSec) {
  const phase = ((tSec / 12 + posePhase(profile)) % 1 + 1) % 1
  const smooth = v => { v = Math.max(0, Math.min(1, v)); return v * v * (3 - 2 * v) }
  const lift = phase < 0.25 ? 0 : phase < 0.48 ? smooth((phase - 0.25) / 0.23)
    : phase < 0.64 ? 1 : phase < 0.88 ? 1 - smooth((phase - 0.64) / 0.24) : 0
  const stage = phase < 0.25 || phase >= 0.88 ? 'rest' : phase < 0.48 ? 'lift' : phase < 0.64 ? 'sip' : 'lower'
  const breath = 0.004 * Math.sin(tSec * 1.1 + posePhase(profile) * 6.28)
  const topZ = 1.06 + breath
  const head = [slot.x, slot.y, topZ + 0.37]
  const mix = (a,b) => a + (b-a)*lift
  const cup = [slot.x + mix(0.37, 0.12), slot.y + mix(0.12, 0.10), mix(0.68, head[2] - 0.206)]
  const hand = [cup[0] + 0.08, cup[1] - 0.015, cup[2] + 0.015]
  return {phase, lift, stage, topZ, seatZ: 0.46, head, headR: 0.26, cup, hand,
    shoulders: [[slot.x-0.24,slot.y,topZ-0.09],[slot.x+0.24,slot.y,topZ-0.09]],
    elbows: [[slot.x-0.31,slot.y+0.12,0.66],[slot.x+0.42,slot.y+0.16,0.79]],
    lapHand: [slot.x-0.16,slot.y+0.17,0.39],
    legs: [-1,1].map(a => ({hip:[slot.x+a*0.14,slot.y,0.49],
      knee:[slot.x+a*0.20,slot.y+0.18,0.26],foot:[slot.x+a*0.23,slot.y+0.21,0.05]}))}
}
// Explicit shoulder/elbow/wrist segments, with a rounded joint at the elbow.
function drawPoseArm(c, project, shoulder, elbow, hand, width, cloth, skin) {
  const a=project(shoulder), b=project(elbow), d=project(hand)
  drawLimb(c,a,b,width,cloth)
  drawLimb(c,b,d,width*0.86,cloth)
  fillEllipse(c,d[0],d[1],width*0.62,width*0.55,skin)
}

function drawDeskAndAvatar(c, ox, oy, scale, slot, entry, index, tSec, palette) {
  const { stroke, textSec, textTer, textQuat, accent, P } = palette
  const online = !!entry.online
  const busy = !!entry.busy
  const alpha = online ? 1 : 0.45
  const pcolor = profileColor(entry.profile) || accent
  const S = deskLayout(slot)

  c.save()
  c.globalAlpha = alpha

  // ---- Desk ----------------------------------------------------------------
  // Grounding shadow, then a soft-shaded top so the wood catches the light
  // along its back edge instead of reading as a wireframe box.
  softShadow(c, ox, oy, slot.x + DESK_W / 2, slot.y + DESK_D / 2, 1.05, scale,
    P.shadowInk, 0.20)
  drawIsoBoxSoft(c, ox, oy, slot.x, slot.y, 0, DESK_W, DESK_D, 0.75, scale, P.deskWood)

  // ---- Monitor: plinth + neck + bezel panel, and the light it throws ------
  const monX = S.monX
  const monY = S.monY
  const panW = S.panW
  const panD = S.panD
  const panH = S.panH
  const panZ = S.panZ
  const monCX = monX + panW * 0.5
  const monCY = monY + panD * 0.5
  drawIsoDiscSoft(c, ox, oy, monCX, monCY, 0.77, 0.15, scale, P.monitorShell, { top: 0.10 })
  drawCylinder(c, ox, oy, monCX, monCY, 0.75, panZ + 0.02, 0.045, scale, P.monitorShell)
  // The halo the panel throws is drawn BEFORE the panel, so it spills around it
  // rather than washing over the screen. Additive, tinted by the running state.
  if (online) {
    const glowInk = busy ? P.screenGreenBusy : P.screenGreenIdle
    const rgb = hexToRgb(glowInk) || { r: 140, g: 230, b: 170 }
    const [gx, gy] = screenPt(ox, oy, monCX, monCY, panZ + panH * 0.5, scale)
    const gr = Math.max(6, panW * 0.5 * scale * 2.0)
    const gg = c.createRadialGradient(gx, gy, gr * 0.10, gx, gy, gr)
    gg.addColorStop(0, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ', 0.16)')
    gg.addColorStop(0.5, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ', 0.06)')
    gg.addColorStop(1, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ', 0)')
    c.save()
    c.globalCompositeOperation = 'lighter'
    fillEllipse(c, gx, gy, gr, gr, gg)
    c.restore()
  }
  drawIsoBoxSoft(c, ox, oy, monX, monY, panZ, panW, panD, panH, scale,
    P.monitorShell, { top: 0.16 })

  // The screen itself: the panel's FRONT face (+y side), inset for the bezel.
  // (u, v) ∈ [0,1]² maps onto that inset parallelogram, so the fake code lines
  // land on the glass rather than over the frame.
  const bezU0 = 0.055
  const bezU1 = 0.945
  const bezV0 = 0.07
  const bezV1 = 0.93
  const sp = (u, v) => screenPt(
    ox, oy,
    monX + (bezU0 + u * (bezU1 - bezU0)) * panW,
    monY + panD,
    panZ + (bezV0 + v * (bezV1 - bezV0)) * panH,
    scale,
  )
  {
    const p00 = sp(0, 0)
    const p10 = sp(1, 0)
    const p11 = sp(1, 1)
    const p01 = sp(0, 1)
    // Cool-grey glass either way: brightness alone signals on/off, so the
    // screen never clashes with the profile-colored person in front of it.
    const sg = c.createLinearGradient(p01[0], p01[1], p11[0], p11[1])
    sg.addColorStop(0, online ? P.screenOnGlow : P.screenOffGlow)
    sg.addColorStop(1, online ? P.screenOnBase : P.screenOff)
    c.beginPath()
    c.moveTo(p00[0], p00[1])
    c.lineTo(p10[0], p10[1])
    c.lineTo(p11[0], p11[1])
    c.lineTo(p01[0], p01[1])
    c.closePath()
    c.fillStyle = sg
    c.fill()
  }

  // Screen CONTENT when online: fake code/UI lines so a running station looks
  // alive. Terminal-green regardless of the profile hue.
  if (online) {
    c.save()
    const screenText = busy ? P.screenGreenBusy : P.screenGreenIdle
    // Title bar across the top.
    c.strokeStyle = screenText
    c.lineWidth = 2
    const [tx0, ty0] = sp(0.10, 0.86)
    const [tx1, ty1] = sp(0.58, 0.86)
    c.beginPath(); c.moveTo(tx0, ty0); c.lineTo(tx1, ty1); c.stroke()
    // Code lines: a few left-aligned rows of varying width, brighter when busy.
    c.lineWidth = busy ? 1.6 : 1.2
    const rows = [
      [0.10, 0.68, 0.58],
      [0.18, 0.56, 0.66],
      [0.18, 0.44, 0.44],
      [0.10, 0.32, 0.62],
      [0.26, 0.20, 0.36],
    ]
    for (let i = 0; i < rows.length; i++) {
      const [uStart, v, uLen] = rows[i]
      c.strokeStyle = screenText
      const [ax2, ay2] = sp(uStart, v)
      const [bx2, by2] = sp(uStart + uLen, v)
      c.beginPath(); c.moveTo(ax2, ay2); c.lineTo(bx2, by2); c.stroke()
    }
    // Busy: a blinking cursor block at the end of an active line.
    if (busy) {
      const blink = (Math.sin(tSec * 4 + index) + 1) / 2
      c.globalAlpha = 0.35 + 0.55 * blink
      c.fillStyle = screenText
      const [cxp, cyp] = sp(0.60, 0.68)
      const [cxp2] = sp(0.64, 0.68)
      const cw = Math.abs(cxp2 - cxp) || 3
      c.fillRect(cxp, cyp - 3, cw, 6)
    }
    c.restore()
  }

  // ---- Keyboard + mouse: what the hands are actually on -------------------
  // Without these the hands hovered over a bare desktop and the arms had to
  // reach to the monitor to land anywhere. The keyboard sits at the FRONT of
  // the desk, close to the sitter, so the arms fall forward-and-down.
  const kbX = S.kbX
  const kbY = S.kbY
  const kbW = S.kbW
  const kbD = S.kbD
  drawIsoBoxSoft(c, ox, oy, kbX, kbY, 0.75, kbW, kbD, 0.045, scale,
    P.keyboard, { top: 0.06, edgeAlpha: 0.10 })
  drawIsoDiscSoft(c, ox, oy, kbX + kbW + 0.13, kbY + kbD * 0.5, 0.795, 0.065,
    scale, P.keyboard, { top: 0.16 })

  // A mug on the free right-hand end of the desk, so the surface is not bare.
  const mugX = S.mugX
  const mugY = S.mugY
  drawCylinder(c, ox, oy, mugX, mugY, 0.75, 0.90, 0.10, scale, P.chairBackTop)
  drawIsoDiscSoft(c, ox, oy, mugX, mugY, 0.905, 0.075, scale, P.hair, { top: 0.10 })

  // ---- Chair: plinth + gas post + cushion (the backrest paints later) -----
  // The sitter sits at the LEFT end of the desk, not on the centre line: in this
  // projection "forward" (-y) also moves a point up-and-right on screen, so a
  // centred sitter leaves their hands inside their own torso silhouette (they
  // read as sitting on their lap). Clearance is a property of (x - y): a hand
  // shows outside the torso only when its (x - y) exceeds the torso's by ~0.41.
  const chairX = S.chairX
  const chairY = S.chairY
  const chairCX = S.cx
  const chairCY = S.cy
  drawIsoDiscSoft(c, ox, oy, chairCX, chairCY, 0.02, 0.30, scale, P.chairBase, { top: 0.08 })
  drawCylinder(c, ox, oy, chairCX, chairCY, 0.02, 0.34, 0.055, scale, P.chairPost)
  drawCylinder(c, ox, oy, chairCX, chairCY, 0.34, 0.48, 0.33, scale, P.chairTop)
  // Chair BACK is drawn later (after the sitter) so it correctly occludes their
  // lower back — in iso painter's order the backrest sits at the highest +y and
  // must paint last.
  const drawChairBack = () => {
    drawIsoBoxSoft(c, ox, oy, chairX + 0.02, chairY + 0.72, 0.46, 0.86, 0.16, 0.62,
      scale, P.chairBackTop, { top: 0.14 })
  }

  // At-desk avatar only when busy
  if (busy) {
    const pose = deskPose(slot, entry.profile, tSec)
    const typing = pose.breath
    const cxw = S.cx // sitter centre (world)
    const cyw = S.cy
    const seatZ = S.seatZ + typing
    const topZ = S.topZ + typing

    // The sitter is a shaded FIGURE: a grounding shadow, a gradient-cylinder
    // torso (the CLOTHES carry the profile color = identity, while skin/hair stay
    // neutral), a NARROW neck so the head is not a ball glued to the shoulders,
    // two arms reaching down-forward onto the keyboard, and a sphere head.
    // The arms are painted BEFORE the torso, and that ordering is the whole fix:
    // each shoulder sits INSIDE the torso's silhouette while each hand is well
    // OUTSIDE it, so the body occludes the top of every arm and both hands stay
    // visible on the keys. Painting the arms LAST instead lays the near hand ON
    // TOP of the body (the layering bug) — only the draw order matters here.
    const armW = Math.max(1.5, 0.15 * scale)
    const armBase = shade(pcolor, -0.20)
    const project = p => screenPt(ox,oy,...p,scale)
    softShadow(c, ox, oy, cxw, cyw, 0.72, scale, P.shadowInk, 0.30)
    // Both arms remain behind the torso, preserving the approved handedness.
    for (let a=0;a<2;a++) drawPoseArm(c,project,pose.shoulders[a],pose.elbows[a],
      pose.hands[a],armW,armBase,P.skin)

    drawCylinder(c, ox, oy, cxw, cyw, seatZ, topZ, S.torsoR, scale, pcolor)
    // Collar + neck. The collar (clothes, wider) frames the neck, and the head
    // sits low enough that the neck is nearly all covered — a bare skin
    // cylinder on the shoulders read as a bald patch.
    drawCylinder(c, ox, oy, cxw, cyw, topZ - 0.07, S.collarTopZ + typing, S.collarR,
      scale, shade(pcolor, -0.14))
    drawCylinder(c, ox, oy, cxw, cyw, topZ - 0.08, S.neckTopZ + typing, S.neckR,
      scale, P.skin)

    // Head: shaded sphere + hair; the blink is a rare, quick squash. Facing is
    // the DESK direction (-y in world = up-right on screen), so we see the back
    // of the head — the sitter is looking at the monitor, not out at us.
    const headR = S.headR * scale
    const [hx, hy] = screenPt(ox, oy, cxw, cyw, S.headCz + typing, scale)
    const blink = Math.sin(tSec * 1.4 + index * 2.1) > 0.965 ? 0.14 : 1
    drawHead(c, hx, hy, headR, {
      skin: P.skin,
      skinShadow: P.skinShadow,
      hair: P.hair,
      hairLit: P.hairLit,
      facing: DESK_FACING,
      blink,
    })

    // Backrest paints after the sitter so it occludes their back.
    drawChairBack()

    // Floating name label just above the head.
    const nameFontPx = 10
    c.font = nameFontPx + 'px system-ui, -apple-system, "Segoe UI", sans-serif'
    c.textAlign = 'center'
    drawNameBadge(c, entry.profile, hx, hy - headR - 6, {
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
  const pose = loungePose(slot, entry.profile, online ? tSec : 0)
  const project = p => screenPt(ox,oy,...p,scale)

  c.save()
  c.globalAlpha = alpha

  // Stool: a neutral column with a seat cushion on top, so the sitter has
  // something to sit on and legs that reach the floor.
  softShadow(c, ox, oy, slot.x, slot.y - 0.14, 0.62, scale, P.shadowInk, 0.26)
  drawCylinder(c, ox, oy, slot.x, slot.y, 0, 0.38, 0.28, scale, P.chairPost)
  drawCylinder(c, ox, oy, slot.x, slot.y, 0.38, 0.45, 0.33, scale, P.stool)
  drawIsoDiscSoft(c, ox, oy, slot.x, slot.y, 0.455, 0.33, scale, P.chairTop, { top: 0.16 })

  const seatZ = pose.seatZ
  const legW = Math.max(1.5, 0.17 * scale)
  for (const leg of pose.legs) {
    const hip=project(leg.hip), knee=project(leg.knee), foot=project(leg.foot)
    drawLimb(c,hip,knee,legW,P.trouser)
    drawLimb(c,knee,foot,legW*0.86,P.trouser)
    fillEllipse(c,foot[0]+legW*0.34,foot[1]+legW*0.22,legW*0.74,legW*0.44,P.shoe)
  }
  const topZ = pose.topZ
  const armW = Math.max(1.4, 0.145 * scale)
  const handBase = shade(pcolor,-0.16)
  // Far sleeve disappears behind the body; its hand rests visibly on the knee.
  drawPoseArm(c,project,pose.shoulders[0],pose.elbows[0],pose.lapHand,armW,handBase,P.skin)
  drawCylinder(c,ox,oy,slot.x,slot.y,seatZ,topZ,0.26,scale,pcolor)
  drawCylinder(c,ox,oy,slot.x,slot.y,topZ-0.03,topZ+0.11,0.105,scale,P.skin)
  const headR = pose.headR
  const headCZ = pose.head[2]
  const [hx,hy] = project(pose.head)
  const blink = Math.sin(tSec * 1.4 + idx * 2.1) > 0.965 ? 0.14 : 1
  drawHead(c, hx, hy, headR * scale, {
    skin: P.skin,
    skinShadow: P.skinShadow,
    hair: P.hair,
    hairLit: P.hairLit,
    facing: LOUNGE_FACING,
    blink,
  })

  // Near arm and cup share one pose. Cup rim stops at the LOWER lip, not
  // through the face; cup body and grasp paint in front of the raised forearm.
  drawPoseArm(c,project,pose.shoulders[1],pose.elbows[1],pose.hand,armW,handBase,P.skin)
  if (online) {
    const [cupX,cupY,cupZ] = pose.cup
    drawCylinder(c,ox,oy,cupX,cupY,cupZ-0.055,cupZ+0.08,0.085,scale,'#f2ede4')
    drawIsoDiscSoft(c,ox,oy,cupX,cupY,cupZ+0.082,0.067,scale,'#76543b')
    const hp=project(pose.hand)
    fillEllipse(c,hp[0],hp[1],armW*0.46,armW*0.40,P.skin)
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
function OfficeCanvas({ entries, selectedIndex, onPick }) {
  const containerRef = useRef(null)
  const canvasRef = useRef(null)
  const rafRef = useRef(0)
  const startRef = useRef(0)
  const entriesRef = useRef(entries)
  // Transform of the last drawn frame, so a click can be hit-tested against the
  // exact projection the pixels came from.
  const frameRef = useRef(null)
  const selectedRef = useRef(selectedIndex)
  const onPickRef = useRef(onPick)
  // Zoom/pan view. The rAF loop reads the ref (it must see the newest value
  // without re-subscribing); the state copy drives the overlay readout.
  const [view, setView] = useState({ zoom: 1, panX: 0, panY: 0 })
  const viewRef = useRef(view)
  const dragRef = useRef(null)
  const suppressClickRef = useRef(false)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    entriesRef.current = entries
  }, [entries])

  useEffect(() => {
    selectedRef.current = selectedIndex
  }, [selectedIndex])

  useEffect(() => {
    onPickRef.current = onPick
  }, [onPick])

  useEffect(() => {
    viewRef.current = view
  }, [view])

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
          frameRef.current = drawFrame(
            canvas, c2, entriesRef.current || [], tSec, selectedRef.current,
            viewRef.current,
          )
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

  // Canvas box + scene layout, from the LIVE DOM (not props), so a zoom always
  // uses the same numbers drawFrame just used.
  const viewport = () => {
    const rect = containerRef.current
      ? containerRef.current.getBoundingClientRect()
      : null
    const count = (entriesRef.current || []).length
    return {
      cssW: Math.max(200, rect ? Math.floor(rect.width) : 640),
      cssH: Math.max(200, rect ? Math.floor(rect.height) : 400),
      L: sceneLayout(count),
    }
  }

  // Zoom keeping the point under (ax, ay) — the cursor for wheel, the canvas
  // centre for the buttons — pinned to its screen position.
  const applyZoom = (nextZoom, ax, ay) => {
    const vp = viewport()
    setView(zoomAbout(vp.cssW, vp.cssH, vp.L, viewRef.current, nextZoom, ax, ay))
  }
  const resetView = () => setView({ zoom: 1, panX: 0, panY: 0 })

  const handleWheel = (event) => {
    // ⌘/Ctrl + wheel zooms (a trackpad pinch arrives as ctrlKey). A plain wheel
    // is left alone so the page still scrolls over the canvas.
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY
    const factor = Math.pow(1.0018, -delta)
    applyZoom(
      viewRef.current.zoom * factor,
      event.clientX - rect.left,
      event.clientY - rect.top,
    )
  }

  // Drag to pan. A press that never moves is still a click, so the desk pick
  // keeps working; once the pointer travels past a few px it becomes a pan and
  // the click that follows the release is swallowed.
  const handlePointerDown = (event) => {
    if (event.button !== 0) return
    dragRef.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      panX: viewRef.current.panX,
      panY: viewRef.current.panY,
      moved: false,
    }
  }

  const handlePointerMove = (event) => {
    const d = dragRef.current
    if (!d || d.id !== event.pointerId) return
    const dx = event.clientX - d.x
    const dy = event.clientY - d.y
    if (!d.moved) {
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return
      d.moved = true
      setDragging(true)
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch (err) {
        // Capture is a nicety; the drag works without it.
      }
    }
    setView({ zoom: viewRef.current.zoom, panX: d.panX + dx, panY: d.panY + dy })
  }

  const endDrag = (event) => {
    const d = dragRef.current
    if (!d) return
    dragRef.current = null
    if (!d.moved) return
    suppressClickRef.current = true
    setDragging(false)
    try {
      event.currentTarget.releasePointerCapture(d.id)
    } catch (err) {
      // Already released.
    }
  }

  // Click a desk -> report the profile (or null for a miss). The canvas draws in
  // logical CSS px (drawFrame scales the context by dpr itself), so clientX/Y
  // minus the element rect is already in the frame's coordinate space.
  const handleClick = (event) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    const pick = onPickRef.current
    if (!pick) return
    const frame = frameRef.current
    const list = entriesRef.current || []
    if (!frame) return
    const rect = event.currentTarget.getBoundingClientRect()
    const index = hitTestDesks(
      list, frame, event.clientX - rect.left, event.clientY - rect.top,
    )
    pick(index >= 0 ? list[index] : null)
  }

  const zoomPct = Math.round(view.zoom * 100)
  const atFit = view.zoom === 1 && view.panX === 0 && view.panY === 0
  const btn =
    'px-1.5 py-1 leading-none rounded text-[var(--ui-text-secondary)] ' +
    'hover:bg-[rgba(127,127,127,0.18)] active:bg-[rgba(127,127,127,0.28)]'

  return jsxs('div', {
    ref: containerRef,
    className: cn('relative w-full h-full min-h-[380px] select-none'),
    children: [
      jsx('canvas', {
        ref: canvasRef,
        onClick: handleClick,
        onWheel: handleWheel,
        onPointerDown: handlePointerDown,
        onPointerMove: handlePointerMove,
        onPointerUp: endDrag,
        onPointerCancel: endDrag,
        onDoubleClick: resetView,
        style: { touchAction: 'none' },
        title: 'Click a desk to inspect · ⌘/Ctrl + scroll to zoom · drag to pan · double-click to fit',
        className: cn(
          'block w-full h-full rounded-md border border-[var(--ui-stroke-secondary)]',
          onPick ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : '',
        ),
      }),
      jsxs('div', {
        className:
          'absolute right-2 top-2 flex items-center gap-0.5 rounded-md ' +
          'border border-[var(--ui-stroke-secondary)] bg-[var(--ui-bg)] px-0.5 py-0.5 ' +
          'text-xs shadow-sm',
        children: [
          jsx('button', {
            type: 'button',
            className: btn,
            title: 'Zoom out',
            onClick: () => applyZoom(view.zoom / 1.3),
            children: '\u2212',
          }),
          jsx('button', {
            type: 'button',
            className: cn(btn, 'min-w-[3.4rem] text-center font-medium tabular-nums'),
            title: 'Back to fit (100%)',
            onClick: resetView,
            children: zoomPct + '%',
          }),
          jsx('button', {
            type: 'button',
            className: btn,
            title: 'Zoom in',
            onClick: () => applyZoom(view.zoom * 1.3),
            children: '+',
          }),
        ],
      }),
      atFit
        ? jsx('span', {
            className:
              'absolute left-2 bottom-2 pointer-events-none text-[10px] ' +
              'text-[var(--ui-text-tertiary)]',
            children: '\u2318/Ctrl + scroll to zoom \u00b7 drag to pan',
          })
        : null,
    ],
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

// ---------------------------------------------------------------------------
// Preferences (desktop-half-local, persisted with ctx.storage).
// ---------------------------------------------------------------------------
const PREFS_KEY = 'prefs'
const PREFS_DEFAULTS = {
  pollSeconds: 5,
  hideOffline: false,
  notifyOnChange: false,
}
const POLL_CHOICES = ['2', '5', '15', '60']

function readPrefs(ctx) {
  let stored = {}
  try {
    stored = ctx.storage.get(PREFS_KEY, {}) || {}
  } catch (err) {
    stored = {}
  }
  const merged = { ...PREFS_DEFAULTS, ...stored }
  // Tolerate a hand-edited or older stored value.
  const secs = Number(merged.pollSeconds)
  merged.pollSeconds =
    Number.isFinite(secs) && secs >= 2 && secs <= 300
      ? Math.round(secs)
      : PREFS_DEFAULTS.pollSeconds
  merged.hideOffline = !!merged.hideOffline
  merged.notifyOnChange = !!merged.notifyOnChange
  return merged
}

// Aggregate the per-profile entries into the numbers the chips show.
function summarize(entries) {
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
}

// Settings ▸ Plugins ▸ Office 3D. Built from the app's own settings rows so it
// looks like core Settings.
function OfficeSettingsPage({ prefs, update }) {
  const { pollSeconds, hideOffline, notifyOnChange } = useValue(prefs)
  return jsxs('div', {
    className: 'flex flex-col',
    children: [
      jsx(ListRow, {
        title: 'Refresh interval',
        description:
          'How often the office asks the backend for profile state. The canvas animates continuously; this only controls the data poll.',
        action: jsx(SegmentedControl, {
          value: String(pollSeconds),
          onChange: (value) => update({ pollSeconds: Number(value) }),
          options: POLL_CHOICES.map((s) => ({ id: s, label: s + 's' })),
        }),
      }),
      jsx(ToggleRow, {
        checked: hideOffline,
        label: 'Hide offline profiles',
        description:
          'Draw only profiles that are online, so the office shows what is actually running.',
        onChange: (on) => update({ hideOffline: on }),
      }),
      jsx(ToggleRow, {
        checked: notifyOnChange,
        label: 'Notify when a profile changes state',
        description:
          'A desktop toast when a profile goes busy, idle or offline. The status-bar chip is the poller, so keep it enabled for this to fire.',
        onChange: (on) => update({ notifyOnChange: on }),
      }),
    ],
  })
}

// Status-bar chip: a one-glance summary that is always mounted, so it is also
// where the optional state-change notifications come from.
function OfficeStatusChip({ ctx, prefs }) {
  const { pollSeconds, notifyOnChange } = useValue(prefs)
  const query = useQuery({
    queryKey: OFFICE_QUERY_KEY,
    queryFn: () => ctx.rest('/state'),
    refetchInterval: () =>
      typeof document !== 'undefined' && document.hidden
        ? false
        : pollSeconds * 1000,
    refetchOnWindowFocus: true,
  })
  const entries = Array.isArray(query.data) ? query.data : []
  const stats = useMemo(() => summarize(entries), [entries])

  // Opt-in: toast when a profile changes state. Seeded from the first payload
  // so enabling the setting (or opening the app) never fires a burst.
  const seenRef = useRef(null)
  useEffect(() => {
    if (!notifyOnChange) return
    const next = new Map()
    for (const e of entries) {
      if (e && e.profile) {
        next.set(e.profile, e.busy ? 'busy' : e.online ? 'idle' : 'offline')
      }
    }
    const prev = seenRef.current
    seenRef.current = next
    if (!prev || next.size === 0) return
    for (const [profile, state] of next) {
      const before = prev.get(profile)
      if (before && before !== state) {
        host.notify({
          kind: 'info',
          title: 'Office 3D',
          message: profile + ' is now ' + state,
          action: { label: 'Open office', onClick: () => host.navigate(OFFICE_PATH) },
        })
      }
    }
  }, [entries, notifyOnChange])

  const hasData = Array.isArray(query.data)
  const label = !hasData
    ? '—'
    : stats.busy > 0
      ? stats.busy + ' busy'
      : stats.online + ' online'

  return jsx(Tip, {
    label:
      'Office 3D — ' + stats.online + ' online · ' + stats.busy + ' busy · ' +
      stats.sessions + ' active session' + (stats.sessions === 1 ? '' : 's'),
    children: jsxs('button', {
      type: 'button',
      onClick: () => host.navigate(OFFICE_PATH),
      className: cn(
        'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem]',
        'text-(--ui-text-tertiary) hover:text-(--ui-text-secondary)',
      ),
      children: [
        jsx('span', { 'aria-hidden': true, children: '🏢' }),
        jsx('span', { className: 'tabular-nums', children: label }),
      ],
    }),
  })
}

function OfficeStats({ entries }) {
  const stats = useMemo(() => summarize(entries), [entries])

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

// ---------------------------------------------------------------------------
// Opening a profile in the main window.
// ---------------------------------------------------------------------------

// Always-available door: a fresh chat draft in that profile (the app switches
// the active backend for us).
function openProfileChat(profile) {
  try {
    host.newChat(profile)
  } catch (err) {
    host.notifyError(err, 'Could not open ' + profile + "'s chat")
  }
}

// Resolve a profile's most recent session through the app's OWN RPC, so we can
// open it core-style. Only session METADATA is read here (id/title/timestamps) —
// never message content. Returns null when nothing resolves, and the caller
// falls back to a fresh chat. Any RPC failure (older gateway, unknown profile,
// a rejected param) degrades to null rather than throwing.
async function resolveLatestSession(profile) {
  try {
    const res = await host.request('session.list', {
      profile,
      limit: 1,
      scope: 'stored',
    })
    const rows = res && Array.isArray(res.sessions) ? res.sessions : []
    const first = rows[0]
    const id = first && (first.session_id || first.id)
    return id ? String(id) : null
  } catch (err) {
    return null
  }
}

function openStoredSession(profile, sessionId) {
  Promise.resolve(host.openSession(sessionId, { profile })).catch((err) =>
    host.notifyError(err, 'Could not open that session'),
  )
}

// One label/value row in the detail panel.
function OfficeMetric({ label, value, tone }) {
  return jsxs('div', {
    className: 'flex items-baseline justify-between gap-3',
    children: [
      jsx('span', {
        className: 'text-xs text-[var(--ui-text-tertiary)]',
        children: label,
      }),
      jsx('span', {
        className: 'text-sm font-semibold tabular-nums text-[var(--ui-text-secondary)]',
        style: tone ? { color: tone } : undefined,
        children: value,
      }),
    ],
  })
}

function OfficeDetailPanel({ entry, onClose }) {
  const pcolor = profileColor(entry.profile) || '#888'
  const state = entry.busy ? 'busy' : entry.online ? 'idle' : 'offline'
  const [sessionId, setSessionId] = useState(null)

  // Resolve the profile's newest session lazily, so "Open latest session" only
  // shows up when there is one to open.
  useEffect(() => {
    let cancelled = false
    setSessionId(null)
    resolveLatestSession(entry.profile).then((id) => {
      if (!cancelled) setSessionId(id)
    })
    return () => {
      cancelled = true
    }
  }, [entry.profile])

  const idle =
    entry.online && !entry.busy && typeof entry.idle_since === 'number'
      ? formatIdle(Date.now() - entry.idle_since * 1000)
      : null

  const button = (label, onClick, primary) =>
    jsx('button', {
      type: 'button',
      onClick,
      className: cn(
        'px-2.5 py-1 rounded-md text-xs font-medium border',
        primary
          ? 'border-[var(--ui-accent)] text-[var(--ui-accent)] hover:bg-[var(--ui-accent)] hover:text-[var(--ui-bg)]'
          : 'border-[var(--ui-stroke-secondary)] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text)]',
      ),
      children: label,
    })

  return jsxs('div', {
    className: 'flex flex-col gap-2.5 p-3 rounded-md border border-[var(--ui-stroke-secondary)] bg-[var(--ui-bg)]',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx('span', {
            className: 'inline-block h-2.5 w-2.5 rounded-full shrink-0',
            style: { backgroundColor: pcolor },
          }),
          jsx('span', {
            className: 'text-sm font-semibold text-[var(--ui-text-secondary)] truncate',
            children: entry.profile,
          }),
          jsx('span', {
            className: 'text-xs text-[var(--ui-text-tertiary)]',
            children: idle ? '· ' + state + ' · ' + idle : '· ' + state,
          }),
          jsx('span', { className: 'flex-1' }),
          jsx('button', {
            type: 'button',
            onClick: onClose,
            title: 'Close',
            'aria-label': 'Close profile details',
            className: 'text-xs text-[var(--ui-text-tertiary)] hover:text-[var(--ui-text-secondary)]',
            children: '✕',
          }),
        ],
      }),
      jsx(OfficeMetric, { label: 'active sessions', value: String(entry.active_sessions | 0) }),
      jsx(OfficeMetric, { label: 'open sessions', value: String(entry.open_sessions | 0) }),
      jsx(OfficeMetric, { label: 'agents', value: String(entry.active_agents | 0) }),
      jsx(OfficeMetric, { label: 'tokens', value: formatCompact(Number(entry.tokens_total) || 0) }),
      jsx(OfficeMetric, {
        label: 'cost',
        value: '$' + (Number(entry.cost_total) || 0).toFixed(2),
        tone: Number(entry.cost_total) > 0 ? '#ffd479' : undefined,
      }),
      jsxs('div', {
        className: 'flex flex-wrap gap-2 pt-0.5',
        children: [
          button('Open chat', () => openProfileChat(entry.profile), true),
          sessionId
            ? button('Open latest session', () => openStoredSession(entry.profile, sessionId))
            : null,
        ],
      }),
      jsx('div', {
        className: 'text-[10px] leading-snug text-[var(--ui-text-tertiary)]',
        children:
          'Totals are aggregate columns only (COUNT/SUM/MAX) from this profile’s state.db, read read-only.',
      }),
    ],
  })
}

function OfficeLeaderboard({ entries, selectedProfile, onSelect }) {
  const [metric, setMetric] = useState('tokens')
  const rows = useMemo(() => {
    const list = (Array.isArray(entries) ? entries : []).slice()
    list.sort((a, b) => leaderValue(b, metric) - leaderValue(a, metric))
    return list
  }, [entries, metric])

  const body = rows.map((entry, i) =>
    jsxs('button', {
      type: 'button',
      onClick: () => onSelect(entry),
      className: cn(
        'flex w-full items-center gap-2 px-2 py-1 rounded-md text-left',
        entry.profile === selectedProfile
          ? 'bg-[var(--ui-accent)]/15'
          : 'hover:bg-[var(--ui-bg)]',
      ),
      children: [
        jsx('span', {
          className: 'w-4 text-right text-[10px] tabular-nums text-[var(--ui-text-tertiary)]',
          children: String(i + 1),
        }),
        jsx('span', {
          className: 'inline-block h-2 w-2 rounded-full shrink-0',
          style: { backgroundColor: profileColor(entry.profile) || '#888' },
        }),
        jsx('span', {
          className: 'flex-1 truncate text-xs text-[var(--ui-text-secondary)]',
          children: entry.profile,
        }),
        jsx('span', {
          className: 'text-xs font-semibold tabular-nums text-[var(--ui-text-secondary)]',
          children: metric === 'tokens'
            ? formatCompact(Number(entry.tokens_total) || 0)
            : '$' + (Number(entry.cost_total) || 0).toFixed(2),
        }),
      ],
    }, entry.profile))

  return jsxs('div', {
    className: 'flex flex-col gap-2 p-3 rounded-md border border-[var(--ui-stroke-secondary)] bg-[var(--ui-bg)]',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between gap-2',
        children: [
          jsx('span', {
            className: 'text-xs font-semibold text-[var(--ui-text-secondary)]',
            children: 'Leaderboard',
          }),
          jsx(SegmentedControl, {
            value: metric,
            onChange: (value) => setMetric(value === 'cost' ? 'cost' : 'tokens'),
            options: [
              { id: 'tokens', label: 'tokens' },
              { id: 'cost', label: 'cost' },
            ],
          }),
        ],
      }),
      body.length
        ? jsx('div', { className: 'flex flex-col gap-0.5', children: body })
        : jsx('div', {
            className: 'text-xs text-[var(--ui-text-tertiary)]',
            children: 'No profiles to rank yet.',
          }),
      jsx('div', {
        className: 'text-[10px] leading-snug text-[var(--ui-text-tertiary)]',
        children: 'Click a row to inspect that profile.',
      }),
    ],
  })
}

// Which number the leaderboard ranks on.
function leaderValue(entry, metric) {
  if (!entry || typeof entry !== 'object') return 0
  return metric === 'cost'
    ? Number(entry.cost_total) || 0
    : Number(entry.tokens_total) || 0
}

function OfficePage({ ctx, prefs }) {
  const { pollSeconds, hideOffline } = useValue(prefs)
  const [selectedProfile, setSelectedProfile] = useState(null)
  // Pause polling while the document is hidden (other tab / minimized).
  // Canvas rAF already stops on visibilitychange; the query must too,
  // otherwise we keep opening backend work on a page nobody sees.
  // The status-bar chip polls the same query key, so this never doubles up.
  const query = useQuery({
    queryKey: OFFICE_QUERY_KEY,
    queryFn: () => ctx.rest('/state'),
    refetchInterval: () =>
      typeof document !== 'undefined' && document.hidden
        ? false
        : pollSeconds * 1000,
    refetchOnWindowFocus: true,
  })

  // Selecting a desk or a leaderboard row. Held by profile NAME, not index, so
  // it survives a re-sort or a filtered-out row.
  const pick = (entry) => setSelectedProfile(entry && entry.profile ? entry.profile : null)

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
    const all = Array.isArray(query.data) ? query.data : []
    const entries = hideOffline ? all.filter((e) => e && e.online) : all
    const selectedEntry = selectedProfile
      ? entries.find((e) => e && e.profile === selectedProfile) || null
      : null
    const selectedIndex = selectedEntry ? entries.indexOf(selectedEntry) : -1

    if (all.length === 0) {
      body = jsx(EmptyState, {
        title: 'No profiles found',
        description: 'gateway_state.json was not readable for any profile.',
      })
    } else if (entries.length === 0) {
      body = jsx(EmptyState, {
        title: 'Every profile is offline',
        description: 'Nothing is running right now. Turn off "Hide offline profiles" in Settings to see the empty desks.',
      })
    } else {
      body = jsxs('div', {
        className: 'flex flex-col gap-3 w-full h-full',
        children: [
          jsxs('div', {
            className: 'flex flex-col lg:flex-row gap-3 flex-1 min-h-[420px]',
            children: [
              jsx('div', {
                className: 'flex-1 min-h-[380px]',
                children: jsx(OfficeCanvas, { entries, selectedIndex, onPick: pick }),
              }),
              jsxs('div', {
                className: 'w-full lg:w-[300px] shrink-0 flex flex-col gap-2',
                children: [
                  selectedEntry
                    ? jsx(OfficeDetailPanel, {
                        entry: selectedEntry,
                        onClose: () => setSelectedProfile(null),
                      })
                    : null,
                  jsx(OfficeLeaderboard, {
                    entries,
                    selectedProfile,
                    onSelect: pick,
                  }),
                ],
              }),
            ],
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
            children:
              'Isometric 2D · click a desk to inspect · ⌘/Ctrl + scroll to zoom · ' +
              'refreshes every ' + pollSeconds + 's',
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
    // Desktop-half-local preferences, shared by every surface through one atom
    // and persisted with ctx.storage.
    const prefs = atom(readPrefs(ctx))
    const update = (patch) => {
      const next = { ...prefs.get(), ...patch }
      prefs.set(next)
      try {
        ctx.storage.set(PREFS_KEY, next)
      } catch (err) {
        // A storage failure must not break the settings page.
      }
    }
    const openOffice = () => host.navigate(OFFICE_PATH)

    c.register({
      id: 'page',
      area: ROUTES_AREA,
      data: { path: OFFICE_PATH },
      render: () => jsx(OfficePage, { ctx, prefs }),
    })
    c.register({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      data: { path: OFFICE_PATH, label: 'Office', codicon: 'home' },
    })
    // Status-bar chip: the always-mounted summary, and the poller that feeds
    // the optional state-change notifications.
    c.register({
      id: 'status',
      area: STATUSBAR_AREAS.right,
      order: 120,
      render: () => jsx(OfficeStatusChip, { ctx, prefs }),
    })
    c.register({
      id: 'palette-open',
      area: PALETTE_AREA,
      data: {
        id: 'office-3d.open.row',
        label: 'Open Office 3D',
        keywords: ['office', 'profiles', 'agents', 'busy', 'desk'],
        // Render the live keybind combo as the row's hotkey hint.
        action: 'office-3d.open',
        run: openOffice,
      },
    })
    c.register({
      id: 'keybind-open',
      area: KEYBINDS_AREA,
      data: {
        id: 'office-3d.open',
        label: 'Open Office 3D',
        category: 'view',
        defaults: ['mod+shift+o'],
        run: openOffice,
      },
    })
    // Settings ▸ Plugins ▸ Office 3D. Feature-detected so the plugin still
    // loads on hosts that predate ctx.registerSettingsPage.
    ctx.registerSettingsPage?.({
      id: 'settings',
      title: 'Office 3D',
      icon: 'organization',
      order: 0,
      render: () => jsx(OfficeSettingsPage, { prefs, update }),
    })
  },
}