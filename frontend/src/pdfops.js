// Core PDF Operations: pdf.js handles rendering/rasterization, pdf-lib handles mutation/overlays, 100% locally.
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { PDFDocument, degrees } from '@cantoo/pdf-lib'
import { readFile, writeFile } from '@tauri-apps/plugin-fs'
import { invoke } from '@tauri-apps/api/core'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export function outputPath(input, suffix, ext = 'pdf') {
  return invoke('output_path', { input, suffix, ext })
}

export function fileSize(path) {
  return invoke('file_size', { path })
}

export function revealFile(path) {
  invoke('reveal', { path })
}

// Open PDF: Returns { bytes, pdf } - bytes for pdf-lib mutation, pdf for rendering
// Pass password for encrypted documents; pdf.js throws PasswordException if wrong/missing
export async function openPdf(path, password) {
  const bytes = await readFile(path)
  // pdf.js takes ownership of buffer; keep a copy for pdf-lib
  const copy = new Uint8Array(bytes)
  const pdf = await pdfjs.getDocument({ data: bytes, password, cMapUrl: undefined }).promise
  return { bytes: copy, pdf }
}

// Open from memory bytes (for demo mode, bypasses file system)
export async function openPdfBytes(bytes) {
  const copy = new Uint8Array(bytes)
  const pdf = await pdfjs.getDocument({ data: bytes }).promise
  return { bytes: copy, pdf }
}

// Unified password-protected document loading for pdf-lib
function loadDoc(bytes, password) {
  return PDFDocument.load(bytes, password ? { password } : undefined)
}

// ---------- Encryption / Decryption ----------
export async function encryptPdf(bytes, password, { noPrint, noCopy }, srcPassword) {
  const doc = await loadDoc(bytes, srcPassword)
  doc.encrypt({
    userPassword: password,
    ownerPassword: password,
    permissions: { printing: noPrint ? false : 'highResolution', copying: !noCopy },
  })
  return doc.save()
}

export async function decryptPdf(bytes, password) {
  const doc = await loadDoc(bytes, password)
  return doc.save() // Re-saving without password removes encryption
}

// "1-3,5,8-10" -> 0-based page index Set; empty string or "all" = all pages
export function parseRange(str, pageCount) {
  const all = new Set(Array.from({ length: pageCount }, (_, i) => i))
  if (!str || !str.trim()) return all
  const set = new Set()
  for (const part of str.split(/[,，、]/)) {
    const p = part.trim()
    if (!p) continue
    const m = p.match(/^(\d+)\s*[-—~]\s*(\d+)$/)
    if (m) {
      if (+m[1] > +m[2]) throw new Error(`Page range "${p}" should be from small to large, e.g., ${m[2]}-${m[1]}`)
      const a = Math.max(1, +m[1])
      const b = Math.min(pageCount, +m[2])
      for (let i = a; i <= b; i++) set.add(i - 1)
    } else if (/^\d+$/.test(p)) {
      const n = +p
      if (n >= 1 && n <= pageCount) set.add(n - 1)
    } else {
      throw new Error(`Invalid page range format: "${p}", e.g.: 1-3,5,8-10`)
    }
  }
  if (set.size === 0) throw new Error("Page range didn't match any pages")
  return set
}

// ---------- Watermark Canvas Generation (supports system fonts, rotation, tiling) ----------

const WM_COLORS = {
  gray: 'rgba(102,112,133,{a})',
  red: 'rgba(220,54,46,{a})',
  blue: 'rgba(22,100,255,{a})',
  black: 'rgba(23,30,48,{a})',
}

/**
 * Generates transparent watermark overlay canvas for the specified page dimensions (pt).
 * opts: { type:'text'|'image', text, color, sizePct, opacity, angle, tile, density, imageBitmap }
 */
export function makeOverlayCanvas(pageW, pageH, opts, scale = 2) {
  const W = Math.round(pageW * scale)
  const H = Math.round(pageH * scale)
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const ctx = cv.getContext('2d')
  const alpha = opts.opacity / 100
  const angleRad = (opts.angle * Math.PI) / 180

  const drawOne = (cx, cy) => {
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(angleRad)
    if (opts.type === 'text') {
      const fontPx = Math.max(10, (W * opts.sizePct) / 100)
      ctx.font = `500 ${fontPx}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`
      ctx.fillStyle = (WM_COLORS[opts.color] || WM_COLORS.gray).replace('{a}', String(alpha))
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(opts.text, 0, 0)
    } else if (opts.imageBitmap) {
      const iw = (W * opts.sizePct) / 100
      const ih = iw * (opts.imageBitmap.height / opts.imageBitmap.width)
      ctx.globalAlpha = alpha
      ctx.drawImage(opts.imageBitmap, -iw / 2, -ih / 2, iw, ih)
      ctx.globalAlpha = 1
    }
    ctx.restore()
  }

  if (opts.tile) {
    // Tiling: step by tile unit size across page including bleed margins
    const gapFactor = { sparse: 2.6, normal: 1.9, dense: 1.35 }[opts.density] || 1.9
    let unit
    if (opts.type === 'text') {
      const fontPx = Math.max(10, (W * opts.sizePct) / 100)
      ctx.font = `500 ${fontPx}px -apple-system, "PingFang SC", sans-serif`
      unit = Math.max(ctx.measureText(opts.text).width, fontPx * 2)
    } else {
      unit = (W * opts.sizePct) / 100
    }
    const step = unit * gapFactor
    let row = 0
    for (let y = -H * 0.2; y < H * 1.2; y += step * 0.72) {
      const offset = row % 2 === 0 ? 0 : step / 2
      for (let x = -W * 0.2; x < W * 1.2; x += step) {
        drawOne(x + offset, y)
      }
      row++
    }
  } else {
    drawOne(W / 2, H / 2)
  }
  return cv
}

function canvasToPngBytes(cv) {
  return new Promise((resolve) => {
    cv.toBlob(async (blob) => resolve(new Uint8Array(await blob.arrayBuffer())), 'image/png')
  })
}

function canvasToJpgBytes(cv, quality) {
  return new Promise((resolve) => {
    cv.toBlob(async (blob) => resolve(new Uint8Array(await blob.arrayBuffer())), 'image/jpeg', quality)
  })
}

// ---------- Layer Watermark: pdf-lib overlays transparent PNG on original vector page ----------
// Pages may have /Rotate attribute: overlay is generated at visible display dimensions,
// then counter-rotated into page coordinate system to ensure correct orientation
export async function watermarkLayer(bytes, pdf, range, wmOpts, onProgress, password) {
  const doc = await loadDoc(bytes, password)
  const pages = doc.getPages()
  // Pages sharing the same dimensions + rotation reuse the same image XObject
  const cache = new Map()
  let done = 0
  for (let i = 0; i < pages.length; i++) {
    if (!range.has(i)) continue
    const page = pages[i]
    const { width: pw, height: ph } = page.getSize()
    const rot = (((page.getRotation().angle || 0) % 360) + 360) % 360
    const vw = rot % 180 === 0 ? pw : ph // Display dimensions
    const vh = rot % 180 === 0 ? ph : pw
    const key = `${Math.round(vw)}x${Math.round(vh)}@${rot}`
    let img = cache.get(key)
    if (!img) {
      const cv = makeOverlayCanvas(vw, vh, wmOpts, 2)
      img = await doc.embedPng(await canvasToPngBytes(cv))
      cache.set(key, img)
    }
    // /Rotate is clockwise on display; counter-rotate here to offset
    const place = {
      0: { x: 0, y: 0, rotate: degrees(0) },
      90: { x: pw, y: 0, rotate: degrees(90) },
      180: { x: pw, y: ph, rotate: degrees(180) },
      270: { x: 0, y: ph, rotate: degrees(270) },
    }[rot]
    page.drawImage(img, { ...place, width: vw, height: vh })
    onProgress?.(++done)
    await new Promise((r) => setTimeout(r)) // Yield to main thread to update progress UI
  }
  return doc.save()
}

// ---------- Tamper-Proof Watermark: renders pages to pixels with embedded watermark ----------
export async function watermarkRaster(bytes, pdf, range, wmOpts, dpi, quality, onProgress, password) {
  const src = await loadDoc(bytes, password)
  const out = await PDFDocument.create()
  const scale = dpi / 72
  let done = 0
  for (let i = 0; i < pdf.numPages; i++) {
    if (range.has(i)) {
      const page = await pdf.getPage(i + 1)
      const vp = page.getViewport({ scale: 1 })
      const rvp = page.getViewport({ scale })
      const cv = document.createElement('canvas')
      cv.width = Math.round(rvp.width)
      cv.height = Math.round(rvp.height)
      const ctx = cv.getContext('2d')
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, cv.width, cv.height)
      await page.render({ canvasContext: ctx, viewport: rvp }).promise
      const overlay = makeOverlayCanvas(vp.width, vp.height, wmOpts, scale)
      ctx.drawImage(overlay, 0, 0, cv.width, cv.height)
      const img = await out.embedJpg(await canvasToJpgBytes(cv, quality))
      const p = out.addPage([vp.width, vp.height])
      p.drawImage(img, { x: 0, y: 0, width: vp.width, height: vp.height })
      page.cleanup()
    } else {
      const [copied] = await out.copyPages(src, [i])
      out.addPage(copied)
    }
    onProgress?.(++done)
    await new Promise((r) => setTimeout(r))
  }
  return out.save()
}

// ---------- Page Operations ----------
export async function extractPages(bytes, keep, password) {
  const src = await loadDoc(bytes, password)
  const out = await PDFDocument.create()
  const idx = [...keep].sort((a, b) => a - b)
  const copied = await out.copyPages(src, idx)
  copied.forEach((p) => out.addPage(p))
  return out.save()
}

export async function rotatePages(bytes, targets, delta, password) {
  const doc = await loadDoc(bytes, password)
  doc.getPages().forEach((p, i) => {
    if (targets.has(i)) p.setRotation(degrees(((p.getRotation().angle + delta) % 360 + 360) % 360))
  })
  return doc.save()
}

export async function mergePdfs(paths, onProgress) {
  const out = await PDFDocument.create()
  let done = 0
  for (const path of paths) {
    const bytes = await readFile(path)
    let src
    try {
      src = await PDFDocument.load(bytes)
    } catch (e) {
      const name = path.split(/[/\\]/).pop()
      throw new Error(`"${name}" is an encrypted file. Please use the "Unlock" tool to remove the password before merging.`)
    }
    const copied = await out.copyPages(src, src.getPageIndices())
    copied.forEach((p) => out.addPage(p))
    onProgress?.(++done)
  }
  return out.save()
}

// ---------- Export Images / Compression ----------
export async function pageToCanvas(pdf, pageIndex, scale) {
  const page = await pdf.getPage(pageIndex + 1)
  const vp = page.getViewport({ scale })
  const cv = document.createElement('canvas')
  cv.width = Math.round(vp.width)
  cv.height = Math.round(vp.height)
  const ctx = cv.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, cv.width, cv.height)
  await page.render({ canvasContext: ctx, viewport: vp }).promise
  page.cleanup()
  return cv
}

export async function exportImages(pdf, range, dpi, format, quality, docPath, onProgress) {
  const scale = dpi / 72
  const outs = []
  let done = 0
  for (const i of [...range].sort((a, b) => a - b)) {
    const cv = await pageToCanvas(pdf, i, scale)
    const bytes = format === 'png' ? await canvasToPngBytes(cv) : await canvasToJpgBytes(cv, quality)
    // Non-conflicting naming for each exported image
    const path = await outputPath(docPath, `_p${String(i + 1).padStart(3, '0')}`, format)
    await writeFile(path, bytes)
    outs.push(path)
    onProgress?.(++done)
  }
  return outs
}

export async function compressPdf(pdf, dpi, quality, onProgress) {
  const out = await PDFDocument.create()
  const scale = dpi / 72
  let done = 0
  for (let i = 0; i < pdf.numPages; i++) {
    const page = await pdf.getPage(i + 1)
    const vp = page.getViewport({ scale: 1 })
    const cv = await pageToCanvas(pdf, i, scale)
    const img = await out.embedJpg(await canvasToJpgBytes(cv, quality))
    const p = out.addPage([vp.width, vp.height])
    p.drawImage(img, { x: 0, y: 0, width: vp.width, height: vp.height })
    onProgress?.(++done)
  }
  return out.save()
}

export async function saveBytes(path, bytes) {
  await writeFile(path, bytes)
  return fileSize(path)
}
