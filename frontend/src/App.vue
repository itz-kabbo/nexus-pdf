<script setup>
import { ref, shallowRef, reactive, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { readFile } from '@tauri-apps/plugin-fs'
import { TextLayer } from 'pdfjs-dist'
import {
  openPdf, openPdfBytes, parseRange, makeOverlayCanvas,
  watermarkLayer, watermarkRaster, extractPages, rotatePages, mergePdfs,
  exportImages, compressPdf, encryptPdf, decryptPdf,
  saveBytes, outputPath, fileSize, revealFile,
} from './pdfops.js'
import { ICONS } from './icons.js'
import {
  buildPageRows, buildTextMap, findMatchesInText, nextZoomStep,
  rotatedSize, rowForPage, scaleForPage, segmentsForMatch,
} from './reader.js'

const NAV = [
  { id: 'read', name: 'read', desc: 'Continuous scrolling document view' },
  { id: 'watermark', name: 'Watermark', desc: 'Text or image watermark, dual layer and anti-deletion raster modes' },
  { id: 'pages', name: 'Pages', desc: 'Extract, delete, or rotate selected pages, output as new file' },
  { id: 'merge', name: 'Merge PDF', desc: 'Combine multiple PDFs into one sequentially' },
  { id: 'export', name: 'Export', desc: 'Export pages as PNG or JPG images' },
  { id: 'compress', name: 'Compress', desc: 'Full page rasterization to greatly reduce scanned file size' },
  { id: 'protect', name: 'Protect', desc: 'Set open password, with optional restrictions on printing and copying' },
  { id: 'unlock', name: 'Unlock', desc: 'Output a password-free copy after unlocking with known password' },
]

const tool = ref('read')
const doc = shallowRef(null) // { path, name, size, bytes, pdf, pageCount, sizes:[{w,h}] }
const errorMsg = ref('')
const dragging = ref(false)
const lastResult = ref(null) // { label, path, extra }
const busy = reactive({ active: false, stage: '', done: 0, total: 0 })
const pwPrompt = reactive({ show: false, path: '', name: '', value: '', wrong: false })

// ---------- Open Document ----------
async function pickAndOpen() {
  const path = await openDialog({ multiple: false, title: 'Open PDF', filters: [{ name: 'PDF Document', extensions: ['pdf'] }] })
  if (typeof path === 'string') await loadDoc(path)
}

async function loadDoc(path, password) {
  errorMsg.value = ''
  lastResult.value = null
  try {
    busyStart('Opening document', 1)
    const { bytes, pdf } = await openPdf(path, password)
    pwPrompt.show = false
    pwPrompt.value = ''
    const sizes = []
    for (let i = 1; i <= pdf.numPages; i++) {
      const vp = (await pdf.getPage(i)).getViewport({ scale: 1 })
      sizes.push({ w: vp.width, h: vp.height })
    }
    const [pageLabels, viewerPrefs, outline] = await Promise.all([
      pdf.getPageLabels().catch(() => null),
      pdf.getViewerPreferences().catch(() => null),
      pdf.getOutline().catch(() => null),
    ])
    const restored = restoreReaderState(path, viewerPrefs)
    saveReaderState()
    for (const task of renderTasks.values()) task.cancel?.()
    renderTasks.clear()
    doc.value?.pdf?.destroy()
    doc.value = {
      path,
      name: path.split(/[/\\]/).pop(),
      size: await fileSize(path),
      bytes, pdf,
      pageCount: pdf.numPages,
      sizes,
      pageLabels,
      password: password || '',
    }
    outlineItems.value = flattenOutline(outline || [])
    currentPage.value = Math.min(pdf.numPages, Math.max(1, restored?.page || 1))
    pageField.value = String(currentPage.value)
    navHistory.value = [currentPage.value]
    navHistoryIndex.value = 0
    renderVersion++
    renderedSet.clear()
    thumbRendered.clear()
    readerThumbRendered.clear()
    textCache.clear()
    contentBoxCache.clear()
    contentBoxTasks.clear()
    clearSearch()
    selected.value = new Set()
    if (!mergeList.value.some((x) => x.path === path)) {
      mergeList.value.unshift({ path, name: doc.value.name })
    }
    await nextTick()
    if (tool.value !== 'read') zoomFit()
    invalidateRendering()
    if (tool.value === 'pages') {
      setupThumbObserver()
    } else {
      setupObserver()
      await navigateToPage(currentPage.value, { history: false, smooth: false })
      if (tool.value === 'read' && readerSidebar.value === 'thumbs') setupReaderThumbObserver()
    }
  } catch (e) {
    if (e?.name === 'PasswordException' || /password/i.test(String(e?.name || e))) {
      // Encrypted document: show password modal, reload upon success
      pwPrompt.show = true
      pwPrompt.path = path
      pwPrompt.name = path.split(/[/\\]/).pop()
      pwPrompt.wrong = !!password
      doc.value = null
    } else {
      errorMsg.value = 'Failed to open: ' + (e.message || e)
    }
  } finally {
    busyEnd()
  }
}

function submitPassword() {
  if (pwPrompt.value) loadDoc(pwPrompt.path, pwPrompt.value)
}

function closeDoc() {
  saveReaderState()
  for (const task of renderTasks.values()) task.cancel?.()
  renderTasks.clear()
  doc.value?.pdf?.destroy()
  doc.value = null
  lastResult.value = null
  outlineItems.value = []
  clearSearch()
  observer?.disconnect()
  readerThumbObserver?.disconnect()
}

// ---------- Reader Component ----------
const viewerEl = ref(null)
const readerSidebarEl = ref(null)
const findInputEl = ref(null)
const pageInputEl = ref(null)
const zoom = ref(1)
const zoomMode = ref('fit-page') // fit-page | fit-width | fit-content | custom
const pageLayout = ref('single') // single | facing | book
const readerContinuous = ref(true)
const rotation = ref(0)
const currentPage = ref(1)
const pageField = ref('1')
const readerSidebar = ref('none') // none | outline | thumbs
const outlineItems = ref([])
const inverted = ref(false)
const fullscreen = ref(false)
const presentation = ref(false)
const navHistory = ref([1])
const navHistoryIndex = ref(0)
const contentBoxRevision = ref(0)
const findState = reactive({
  open: false,
  query: '',
  results: [],
  active: -1,
  searching: false,
  pagesDone: 0,
})

let observer = null
let renderVersion = 0
let zoomTimer = null
let searchTimer = null
let searchToken = 0
let saveStateTimer = null
const renderedSet = new Set() // `${index}@${version}`
const renderedTextLayers = new Map()
const renderTasks = new Map()
const thumbRendered = new Set()
const textCache = new Map()
const contentBoxCache = new Map()
const contentBoxTasks = new Map()

const allReaderRows = computed(() => buildPageRows(doc.value?.pageCount || 0, tool.value === 'read' ? pageLayout.value : 'single'))
const readerRows = computed(() => {
  if (tool.value !== 'read' || readerContinuous.value) return allReaderRows.value
  return [rowForPage(allReaderRows.value, currentPage.value - 1)]
})
const zoomPercent = computed(() => Math.round(pageScale(currentPage.value - 1) * 100))
const zoomLabel = computed(() => ({
  'fit-page': 'Fit Page',
  'fit-width': 'Fit Width',
  'fit-content': 'Fit Content',
  custom: `${zoomPercent.value}%`,
}[zoomMode.value]))
const canNavigateBack = computed(() => navHistoryIndex.value > 0)
const canNavigateForward = computed(() => navHistoryIndex.value < navHistory.value.length - 1)
const currentPageLabel = computed(() => doc.value?.pageLabels?.[currentPage.value - 1] || String(currentPage.value))

function flattenOutline(items, level = 0, output = []) {
  for (const item of items) {
    output.push({
      title: item.title || 'Unnamed chapter',
      dest: item.dest,
      url: item.url,
      level,
      bold: !!item.bold,
      italic: !!item.italic,
    })
    if (item.items?.length) flattenOutline(item.items, level + 1, output)
  }
  return output
}

function restoreReaderState(path, viewerPrefs) {
  pageLayout.value = 'single'
  readerContinuous.value = true
  zoomMode.value = 'fit-page'
  zoom.value = 1
  rotation.value = 0
  readerSidebar.value = 'none'
  inverted.value = false

  const preferred = viewerPrefs?.PageLayout
  if (preferred === 'SinglePage') readerContinuous.value = false
  if (preferred === 'TwoColumnLeft' || preferred === 'TwoColumnRight') pageLayout.value = 'facing'
  if (preferred === 'TwoPageLeft' || preferred === 'TwoPageRight') {
    pageLayout.value = 'book'
    readerContinuous.value = false
  }

  try {
    const saved = JSON.parse(localStorage.getItem(`nexus-bench:reader:${path}`) || 'null')
    if (!saved) return null
    if (['single', 'facing', 'book'].includes(saved.layout)) pageLayout.value = saved.layout
    if (typeof saved.continuous === 'boolean') readerContinuous.value = saved.continuous
    if (['fit-page', 'fit-width', 'fit-content', 'custom'].includes(saved.zoomMode)) zoomMode.value = saved.zoomMode
    if (Number.isFinite(saved.zoom)) zoom.value = saved.zoom
    if ([0, 90, 180, 270].includes(saved.rotation)) rotation.value = saved.rotation
    if (['none', 'outline', 'thumbs'].includes(saved.sidebar)) readerSidebar.value = saved.sidebar
    inverted.value = !!saved.inverted
    return saved
  } catch {
    return null
  }
}

function saveReaderState() {
  clearTimeout(saveStateTimer)
  const d = doc.value
  if (!d) return
  try {
    localStorage.setItem(`nexus-bench:reader:${d.path}`, JSON.stringify({
      page: currentPage.value,
      layout: pageLayout.value,
      continuous: readerContinuous.value,
      zoomMode: zoomMode.value,
      zoom: zoom.value,
      rotation: rotation.value,
      sidebar: readerSidebar.value,
      inverted: inverted.value,
    }))
  } catch {
    // LocalStorage unavailability does not affect reader
  }
}

function scheduleSaveReaderState() {
  clearTimeout(saveStateTimer)
  saveStateTimer = setTimeout(saveReaderState, 250)
}

function pageScale(index) {
  if (!doc.value) return zoom.value
  if (tool.value !== 'read') return zoom.value
  // Trigger template dimension recalculation on Map updates
  void contentBoxRevision.value
  return scaleForPage({
    sizes: doc.value.sizes,
    pageIndex: Math.max(0, index),
    layout: pageLayout.value,
    zoomMode: zoomMode.value,
    customZoom: zoom.value,
    rotation: rotation.value,
    viewportWidth: viewerEl.value?.clientWidth || 900,
    viewportHeight: viewerEl.value?.clientHeight || 700,
    contentBoxes: contentBoxCache,
  })
}

function pageStyle(size, index) {
  const rotated = rotatedSize(size, tool.value === 'read' ? rotation.value : 0)
  const scale = pageScale(index)
  return { width: `${rotated.w * scale}px`, height: `${rotated.h * scale}px` }
}

function invalidateRendering(delay = 0) {
  clearTimeout(zoomTimer)
  zoomTimer = setTimeout(async () => {
    for (const task of renderTasks.values()) task.cancel?.()
    renderTasks.clear()
    renderVersion++
    renderedSet.clear()
    renderedTextLayers.clear()
    await nextTick()
    if (doc.value && tool.value !== 'pages') {
      if (observer) reobserve()
      else setupObserver()
      viewerEl.value?.querySelectorAll('[data-page]').forEach((el) => {
        const rect = el.getBoundingClientRect()
        const rootRect = viewerEl.value.getBoundingClientRect()
        if (rect.bottom >= rootRect.top - 600 && rect.top <= rootRect.bottom + 600) {
          renderPage(+el.dataset.page)
        }
      })
    }
  }, delay)
}

async function setZoomMode(mode) {
  zoomMode.value = mode
  if (mode === 'fit-content' && doc.value) {
    const row = rowForPage(allReaderRows.value, currentPage.value - 1)
    await Promise.all(row.map((index) => detectContentBox(index)))
  }
}

function zoomFit() {
  if (tool.value === 'read') {
    setZoomMode('fit-width')
    return
  }
  if (!doc.value || !viewerEl.value) {
    zoom.value = 1.2
    return
  }
  const maxWidth = Math.max(...doc.value.sizes.map((size) => size.w))
  zoom.value = Math.max(0.3, (viewerEl.value.clientWidth - 72) / maxWidth)
}

function zoomBy(direction, anchorEvent) {
  const current = pageScale(currentPage.value - 1)
  const next = nextZoomStep(current, direction)
  setCustomZoom(next, anchorEvent)
}

async function setCustomZoom(next, anchorEvent) {
  const root = viewerEl.value
  const oldScale = pageScale(currentPage.value - 1)
  let anchor = null
  if (root && anchorEvent) {
    const rect = root.getBoundingClientRect()
    anchor = {
      x: anchorEvent.clientX - rect.left + root.scrollLeft,
      y: anchorEvent.clientY - rect.top + root.scrollTop,
      clientX: anchorEvent.clientX - rect.left,
      clientY: anchorEvent.clientY - rect.top,
    }
  }
  zoom.value = next
  zoomMode.value = 'custom'
  await nextTick()
  if (root && anchor) {
    const ratio = next / Math.max(0.001, oldScale)
    root.scrollLeft = anchor.x * ratio - anchor.clientX
    root.scrollTop = anchor.y * ratio - anchor.clientY
  }
}

watch([zoom, zoomMode, pageLayout, readerContinuous, rotation], () => {
  invalidateRendering(90)
  scheduleSaveReaderState()
})

watch(currentPage, async (page) => {
  pageField.value = String(page)
  scheduleSaveReaderState()
  if (doc.value && tool.value === 'read' && !readerContinuous.value) {
    await nextTick()
    invalidateRendering()
  }
})

watch(readerSidebar, async (value) => {
  scheduleSaveReaderState()
  await nextTick()
  if (value === 'thumbs') setupReaderThumbObserver()
  if (doc.value && tool.value === 'read' && zoomMode.value !== 'custom') invalidateRendering(40)
})

watch(tool, async () => {
  errorMsg.value = ''
  await nextTick()
  if (tool.value === 'pages') {
    setupThumbObserver()
  } else if (doc.value) {
    if (tool.value !== 'read') zoomFit()
    invalidateRendering()
    observer ? reobserve() : setupObserver()
    if (tool.value === 'read' && readerSidebar.value === 'thumbs') setupReaderThumbObserver()
  }
  refreshPreview()
})

function setupObserver() {
  observer?.disconnect()
  if (!viewerEl.value) return
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) renderPage(+entry.target.dataset.page)
      }
      trackCurrentPage()
    },
    { root: viewerEl.value, rootMargin: '600px 0px' }
  )
  reobserve()
}

function reobserve() {
  if (!observer || !viewerEl.value) return
  observer.disconnect()
  viewerEl.value.querySelectorAll('[data-page]').forEach((el) => observer.observe(el))
}

async function getPageText(index, page) {
  const cached = textCache.get(index)
  if (cached) {
    textCache.delete(index)
    textCache.set(index, cached)
    return await cached
  }
  const task = page.getTextContent({ includeMarkedContent: true, disableNormalization: true })
    .then((content) => ({ content, ...buildTextMap(content.items) }))
  textCache.set(index, task)
  while (textCache.size > 36) textCache.delete(textCache.keys().next().value)
  return await task
}

async function renderPage(index) {
  const d = doc.value
  if (!d) return
  const key = `${index}@${renderVersion}`
  if (renderedSet.has(key)) return
  renderedSet.add(key)
  const version = renderVersion
  try {
    if (tool.value === 'read' && zoomMode.value === 'fit-content') {
      await detectContentBox(index)
    }
    const page = await d.pdf.getPage(index + 1)
    if (version !== renderVersion) return
    const scale = pageScale(index)
    const totalRotation = page.rotate + (tool.value === 'read' ? rotation.value : 0)
    const cssViewport = page.getViewport({ scale, rotation: totalRotation })
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const renderViewport = page.getViewport({ scale: scale * dpr, rotation: totalRotation })
    const canvas = viewerEl.value?.querySelector(`canvas[data-cv="${index}"]`)
    if (!canvas) return
    canvas.width = Math.round(renderViewport.width)
    canvas.height = Math.round(renderViewport.height)
    renderTasks.get(index)?.cancel?.()
    const renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport: renderViewport })
    renderTasks.set(index, renderTask)
    try {
      await renderTask.promise
    } finally {
      if (renderTasks.get(index) === renderTask) renderTasks.delete(index)
    }
    if (version !== renderVersion) return
    canvas.dataset.ok = '1'
    if (tool.value === 'read') await renderReaderLayers(page, index, cssViewport, version)
  } catch (error) {
    renderedSet.delete(key)
    if (version === renderVersion && error?.name === 'RenderingCancelledException') {
      setTimeout(() => renderPage(index), 40)
    }
  }
}

async function renderReaderLayers(page, index, viewport, version) {
  const pageEl = viewerEl.value?.querySelector(`.page[data-page="${index}"]`)
  const textEl = pageEl?.querySelector(`[data-text-layer="${index}"]`)
  const annotationEl = pageEl?.querySelector(`[data-annotation-layer="${index}"]`)
  if (!pageEl || !textEl || !annotationEl) return
  textEl.replaceChildren()
  annotationEl.replaceChildren()
  textEl.style.setProperty('--scale-factor', viewport.scale)

  const map = await getPageText(index, page)
  if (version !== renderVersion || !textEl.isConnected) return
  const textLayer = new TextLayer({
    textContentSource: map.content,
    container: textEl,
    viewport,
  })
  await textLayer.render()
  if (version !== renderVersion || !textEl.isConnected) return
  const end = document.createElement('div')
  end.className = 'endOfContent'
  textEl.append(end)
  renderedTextLayers.set(index, { pageEl, textDivs: textLayer.textDivs, map, version })
  renderSearchHighlightsForPage(index)
  await renderAnnotationLinks(page, index, viewport, annotationEl, version)
}

async function renderAnnotationLinks(page, index, viewport, layer, version) {
  const annotations = await page.getAnnotations({ intent: 'display' })
  if (version !== renderVersion || !layer.isConnected) return
  for (const annotation of annotations) {
    if (annotation.subtype !== 'Link' || !annotation.rect) continue
    const rect = viewport.convertToViewportRectangle(annotation.rect)
    const left = Math.min(rect[0], rect[2])
    const top = Math.min(rect[1], rect[3])
    const width = Math.abs(rect[2] - rect[0])
    const height = Math.abs(rect[3] - rect[1])
    const link = annotation.url ? document.createElement('a') : document.createElement('button')
    link.className = 'pdf-link'
    Object.assign(link.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
    })
    link.title = annotation.title || annotation.url || 'Jump to position in document'
    if (annotation.url) {
      link.href = annotation.url
      link.target = '_blank'
      link.rel = 'noreferrer'
    } else {
      link.type = 'button'
      link.addEventListener('click', () => {
        if (annotation.dest) goToDestination(annotation.dest)
        else if (annotation.action === 'NextPage') navigateRelative(1)
        else if (annotation.action === 'PrevPage') navigateRelative(-1)
        else if (annotation.action === 'FirstPage') navigateToPage(1)
        else if (annotation.action === 'LastPage') navigateToPage(doc.value.pageCount)
      })
    }
    layer.append(link)
  }
}

async function detectContentBox(index) {
  if (!doc.value || contentBoxCache.has(index)) return
  if (contentBoxTasks.has(index)) return await contentBoxTasks.get(index)
  const sourcePdf = doc.value.pdf
  const sourceRotation = rotation.value
  const task = (async () => {
    try {
      const page = await sourcePdf.getPage(index + 1)
      const base = page.getViewport({ scale: 1, rotation: page.rotate + sourceRotation })
      const scale = Math.min(0.6, 520 / Math.max(base.width, base.height))
      const viewport = page.getViewport({ scale, rotation: page.rotate + sourceRotation })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(viewport.width))
      canvas.height = Math.max(1, Math.round(viewport.height))
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: ctx, viewport }).promise
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height)
      let minX = width, minY = height, maxX = 0, maxY = 0
      const step = width * height > 300000 ? 2 : 1
      for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
          const p = (y * width + x) * 4
          if (data[p] < 238 || data[p + 1] < 238 || data[p + 2] < 238) {
            minX = Math.min(minX, x)
            minY = Math.min(minY, y)
            maxX = Math.max(maxX, x)
            maxY = Math.max(maxY, y)
          }
        }
      }
      if (maxX > minX && maxY > minY) {
        const padX = width * 0.025
        const padY = height * 0.025
        if (doc.value?.pdf === sourcePdf && rotation.value === sourceRotation) contentBoxCache.set(index, {
          width: Math.min(1, (maxX - minX + padX * 2) / width),
          height: Math.min(1, (maxY - minY + padY * 2) / height),
        })
      }
    } catch {
      // Fall back to conservative 6% margin estimate on scan failure
    } finally {
      contentBoxTasks.delete(index)
      contentBoxRevision.value++
    }
  })()
  contentBoxTasks.set(index, task)
  await task
}

function pushNavigationPoint(page) {
  if (navHistory.value[navHistoryIndex.value] === page) return
  navHistory.value = [...navHistory.value.slice(0, navHistoryIndex.value + 1), page]
  navHistoryIndex.value = navHistory.value.length - 1
}

async function navigateToPage(page, { history = true, smooth = true } = {}) {
  if (!doc.value) return
  const target = Math.min(doc.value.pageCount, Math.max(1, Math.round(Number(page) || 1)))
  if (history) pushNavigationPoint(target)
  currentPage.value = target
  pageField.value = String(target)
  await nextTick()
  if (tool.value === 'read' && !readerContinuous.value) {
    viewerEl.value?.scrollTo({ top: 0, left: 0 })
    await nextTick()
    setupObserver()
    renderPage(target - 1)
    return
  }
  const pageEl = viewerEl.value?.querySelector(`.page[data-page="${target - 1}"]`)
  pageEl?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start', inline: 'nearest' })
}

function submitPageField() {
  const value = pageField.value.trim()
  const labelIndex = doc.value?.pageLabels?.findIndex((label) => label === value) ?? -1
  navigateToPage(labelIndex >= 0 ? labelIndex + 1 : Number(value))
  pageInputEl.value?.select()
}

function navigateRelative(delta) {
  if (!doc.value) return
  const rows = allReaderRows.value
  if (tool.value === 'read' && !readerContinuous.value) {
    const currentRow = Math.max(0, rows.findIndex((row) => row.includes(currentPage.value - 1)))
    const targetRow = rows[Math.min(rows.length - 1, Math.max(0, currentRow + Math.sign(delta)))]
    navigateToPage((targetRow?.[0] ?? 0) + 1, { history: false })
    return
  }
  navigateToPage(currentPage.value + delta, { history: false })
}

function navigateHistory(delta) {
  const next = navHistoryIndex.value + delta
  if (next < 0 || next >= navHistory.value.length) return
  navHistoryIndex.value = next
  navigateToPage(navHistory.value[next], { history: false })
}

async function goToDestination(dest) {
  if (!doc.value || !dest) return
  try {
    const explicit = typeof dest === 'string' ? await doc.value.pdf.getDestination(dest) : dest
    if (!explicit?.length) return
    const ref = explicit[0]
    const index = typeof ref === 'object' ? await doc.value.pdf.getPageIndex(ref) : Number(ref)
    await navigateToPage(index + 1)
  } catch {
    // Broken internal links should not disrupt reading
  }
}

function activateOutline(item) {
  if (item.url) window.open(item.url, '_blank', 'noopener')
  else goToDestination(item.dest)
}

function trackCurrentPage() {
  const root = viewerEl.value
  if (!root || !doc.value || (tool.value === 'read' && !readerContinuous.value)) return
  const rootRect = root.getBoundingClientRect()
  let bestPage = currentPage.value
  let bestScore = -Infinity
  let currentScore = -Infinity
  root.querySelectorAll('.page[data-page]').forEach((el) => {
    const rect = el.getBoundingClientRect()
    const visibleHeight = Math.max(0, Math.min(rect.bottom, rootRect.bottom) - Math.max(rect.top, rootRect.top))
    const visibleWidth = Math.max(0, Math.min(rect.right, rootRect.right) - Math.max(rect.left, rootRect.left))
    const visibleArea = visibleHeight * visibleWidth
    const distance = Math.abs(rect.top - rootRect.top - 18)
    const score = visibleArea - distance * 8
    const page = +el.dataset.page + 1
    if (page === currentPage.value) currentScore = score
    if (score > bestScore || (score === bestScore && page < bestPage)) {
      bestScore = score
      bestPage = page
    }
  })
  // In facing/book mode, preserve explicit target page when both are visible
  if (currentScore > 0 && currentScore >= bestScore - 1) bestPage = currentPage.value
  if (bestScore > -Infinity && bestPage !== currentPage.value) currentPage.value = bestPage
}

// ---------- Outline, Thumbnails, and Search ----------
let readerThumbObserver = null
const readerThumbRendered = new Set()

function setupReaderThumbObserver() {
  readerThumbObserver?.disconnect()
  if (!readerSidebarEl.value) return
  readerThumbObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) renderReaderThumb(+entry.target.dataset.readerThumb)
      }
    },
    { root: readerSidebarEl.value, rootMargin: '300px 0px' }
  )
  readerSidebarEl.value.querySelectorAll('[data-reader-thumb]').forEach((el) => readerThumbObserver.observe(el))
}

async function renderReaderThumb(index) {
  if (readerThumbRendered.has(index) || !doc.value) return
  readerThumbRendered.add(index)
  try {
    const page = await doc.value.pdf.getPage(index + 1)
    const base = page.getViewport({ scale: 1, rotation: page.rotate + rotation.value })
    const scale = (132 * Math.min(window.devicePixelRatio || 1, 2)) / base.width
    const viewport = page.getViewport({ scale, rotation: page.rotate + rotation.value })
    const canvas = readerSidebarEl.value?.querySelector(`canvas[data-reader-thumb-canvas="${index}"]`)
    if (!canvas) return
    canvas.width = Math.round(viewport.width)
    canvas.height = Math.round(viewport.height)
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
  } catch {
    readerThumbRendered.delete(index)
  }
}

watch(rotation, async () => {
  contentBoxCache.clear()
  contentBoxTasks.clear()
  contentBoxRevision.value++
  readerThumbRendered.clear()
  await nextTick()
  if (readerSidebar.value === 'thumbs') setupReaderThumbObserver()
})

const findCounter = computed(() => {
  if (findState.searching) return `${findState.pagesDone} / ${doc.value?.pageCount || 0} Pages`
  if (!findState.query.trim()) return ''
  if (!findState.results.length) return 'No results'
  return `${findState.active + 1} / ${findState.results.length}`
})

function openFind() {
  if (!doc.value || tool.value !== 'read') return
  findState.open = true
  nextTick(() => {
    refreshSearchHighlights()
    findInputEl.value?.focus()
    findInputEl.value?.select()
  })
}

function clearSearch() {
  searchToken++
  clearTimeout(searchTimer)
  findState.open = false
  findState.query = ''
  findState.results = []
  findState.active = -1
  findState.searching = false
  findState.pagesDone = 0
  refreshSearchHighlights()
}

function closeFind() {
  findState.open = false
  findInputEl.value?.blur()
  refreshSearchHighlights()
}

watch(() => findState.query, (query) => {
  clearTimeout(searchTimer)
  if (!query.trim()) {
    searchToken++
    findState.results = []
    findState.active = -1
    findState.searching = false
    refreshSearchHighlights()
    return
  }
  searchTimer = setTimeout(runSearch, query.trim().length <= 2 ? 500 : 260)
})

async function runSearch() {
  const d = doc.value
  const query = findState.query.trim()
  if (!d || !query) return
  const token = ++searchToken
  findState.results = []
  findState.active = -1
  findState.searching = true
  findState.pagesDone = 0
  refreshSearchHighlights()

  for (let index = 0; index < d.pageCount; index++) {
    if (token !== searchToken) return
    try {
      const page = await d.pdf.getPage(index + 1)
      const map = await getPageText(index, page)
      const matches = findMatchesInText(map.text, query)
      for (const match of matches) findState.results.push({ page: index, ...match })
    } catch {
      // Continue searching remaining pages if text extraction fails for one page
    }
    findState.pagesDone = index + 1
    if (index % 4 === 3) await new Promise((resolve) => setTimeout(resolve))
  }

  if (token !== searchToken) return
  findState.searching = false
  findState.active = findState.results.length ? 0 : -1
  refreshSearchHighlights()
  if (findState.active >= 0) showSearchResult(findState.active)
}

function findNext(direction = 1) {
  if (!findState.results.length) {
    if (findState.query.trim()) runSearch()
    return
  }
  const count = findState.results.length
  findState.active = (findState.active + direction + count) % count
  refreshSearchHighlights()
  showSearchResult(findState.active)
}

async function showSearchResult(resultIndex) {
  const result = findState.results[resultIndex]
  if (!result) return
  await navigateToPage(result.page + 1, { history: false, smooth: false })
  renderPage(result.page)
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise((resolve) => requestAnimationFrame(resolve))
    refreshSearchHighlights()
    const highlight = viewerEl.value?.querySelector(`.search-highlight[data-result="${resultIndex}"]`)
    if (highlight) {
      highlight.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
      break
    }
  }
}

function refreshSearchHighlights() {
  for (const index of renderedTextLayers.keys()) renderSearchHighlightsForPage(index)
}

function renderSearchHighlightsForPage(pageIndex) {
  const rendered = renderedTextLayers.get(pageIndex)
  if (!rendered || rendered.version !== renderVersion) return
  const layer = rendered.pageEl.querySelector(`[data-search-layer="${pageIndex}"]`)
  if (!layer) return
  layer.replaceChildren()
  if (!findState.open || !findState.query.trim() || !findState.results.length) return
  const pageRect = rendered.pageEl.getBoundingClientRect()

  findState.results.forEach((match, resultIndex) => {
    if (match.page !== pageIndex) return
    for (const segment of segmentsForMatch(rendered.map.segments, match)) {
      const div = rendered.textDivs[segment.itemIndex]
      const node = div?.firstChild
      if (!node || node.nodeType !== Node.TEXT_NODE) continue
      const range = document.createRange()
      range.setStart(node, Math.min(segment.start, node.textContent.length))
      range.setEnd(node, Math.min(segment.end, node.textContent.length))
      for (const rect of range.getClientRects()) {
        if (!rect.width || !rect.height) continue
        const mark = document.createElement('div')
        mark.className = `search-highlight${resultIndex === findState.active ? ' active' : ''}`
        mark.dataset.result = String(resultIndex)
        Object.assign(mark.style, {
          left: `${rect.left - pageRect.left}px`,
          top: `${rect.top - pageRect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
        })
        layer.append(mark)
      }
    }
  })
}

// ---------- Keyboard, Wheel, Panning, and Fullscreen ----------
const panState = reactive({ active: false, moved: false, x: 0, y: 0, left: 0, top: 0, pointerId: -1 })
let presentationRestore = null

function onViewerWheel(event) {
  if (tool.value !== 'read' || !(event.ctrlKey || event.metaKey)) return
  event.preventDefault()
  zoomBy(event.deltaY < 0 ? 1 : -1, event)
}

function startPan(event) {
  if (tool.value !== 'read' || event.button !== 2 || !viewerEl.value) return
  panState.active = true
  panState.moved = false
  panState.x = event.clientX
  panState.y = event.clientY
  panState.left = viewerEl.value.scrollLeft
  panState.top = viewerEl.value.scrollTop
  panState.pointerId = event.pointerId
  viewerEl.value.setPointerCapture?.(event.pointerId)
}

function movePan(event) {
  if (!panState.active || event.pointerId !== panState.pointerId || !viewerEl.value) return
  const dx = event.clientX - panState.x
  const dy = event.clientY - panState.y
  if (Math.abs(dx) + Math.abs(dy) > 3) panState.moved = true
  viewerEl.value.scrollLeft = panState.left - dx
  viewerEl.value.scrollTop = panState.top - dy
}

function endPan(event) {
  if (event.pointerId !== panState.pointerId) return
  panState.active = false
  viewerEl.value?.releasePointerCapture?.(event.pointerId)
  panState.pointerId = -1
}

function onViewerContextMenu(event) {
  if (tool.value === 'read') event.preventDefault()
}

async function toggleFullscreen(force) {
  const enter = force ?? !fullscreen.value
  try {
    if ('__TAURI_INTERNALS__' in window) {
      await getCurrentWindow().setFullscreen(enter)
    } else if (enter && !document.fullscreenElement) {
      await document.documentElement.requestFullscreen()
    } else if (!enter && document.fullscreenElement) {
      await document.exitFullscreen()
    }
    fullscreen.value = enter
  } catch {
    // Fall back to borderless layout when native fullscreen is unavailable
    fullscreen.value = enter
  }
}

async function togglePresentation() {
  if (!presentation.value) {
    presentationRestore = {
      layout: pageLayout.value,
      continuous: readerContinuous.value,
      zoomMode: zoomMode.value,
      zoom: zoom.value,
    }
    presentation.value = true
    pageLayout.value = 'single'
    readerContinuous.value = false
    zoomMode.value = 'fit-page'
    await toggleFullscreen(true)
  } else {
    presentation.value = false
    if (presentationRestore) {
      pageLayout.value = presentationRestore.layout
      readerContinuous.value = presentationRestore.continuous
      zoomMode.value = presentationRestore.zoomMode
      zoom.value = presentationRestore.zoom
    }
    await toggleFullscreen(false)
  }
}

function cycleZoomMode() {
  const modes = ['fit-page', 'fit-width', 'fit-content']
  const index = modes.indexOf(zoomMode.value)
  setZoomMode(modes[(index + 1 + modes.length) % modes.length])
}

function handleKeydown(event) {
  if (!doc.value || tool.value !== 'read') return
  const target = event.target
  const inField = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable
  const mod = event.metaKey || event.ctrlKey
  const key = event.key
  const lower = key.toLowerCase()

  if (key === 'Escape') {
    if (findState.open) {
      closeFind()
      event.preventDefault()
    } else if (presentation.value) {
      togglePresentation()
      event.preventDefault()
    }
    return
  }
  if (inField) {
    if (key === 'F3') {
      findNext(event.shiftKey ? -1 : 1)
      event.preventDefault()
    }
    return
  }

  if (mod && lower === 'o') {
    pickAndOpen()
    event.preventDefault()
    return
  }
  if (mod && lower === 'w') {
    closeDoc()
    event.preventDefault()
    return
  }
  if (mod && lower === 'f') {
    openFind()
    event.preventDefault()
    return
  }
  if (mod && lower === 'g') {
    pageInputEl.value?.focus()
    pageInputEl.value?.select()
    event.preventDefault()
    return
  }
  if (mod && ['0', '1', '2', '3', '6', '7', '8'].includes(key)) {
    if (key === '0') setZoomMode('fit-page')
    if (key === '1') setCustomZoom(1)
    if (key === '2') setZoomMode('fit-width')
    if (key === '3') setZoomMode('fit-content')
    if (key === '6') pageLayout.value = 'single'
    if (key === '7') pageLayout.value = 'facing'
    if (key === '8') pageLayout.value = 'book'
    event.preventDefault()
    return
  }
  if (event.altKey && key === 'ArrowLeft') {
    navigateHistory(-1)
    event.preventDefault()
    return
  }
  if (event.altKey && key === 'ArrowRight') {
    navigateHistory(1)
    event.preventDefault()
    return
  }
  if (key === 'F12') {
    readerSidebar.value = readerSidebar.value === 'outline' ? 'none' : 'outline'
    event.preventDefault()
    return
  }
  if (key === 'F3') {
    findNext(event.shiftKey ? -1 : 1)
    event.preventDefault()
    return
  }
  if (key === 'F11') {
    toggleFullscreen()
    event.preventDefault()
    return
  }
  if (key === 'F5') {
    togglePresentation()
    event.preventDefault()
    return
  }
  if (key === '/' && !event.shiftKey) {
    openFind()
    event.preventDefault()
    return
  }
  if (lower === 'g') {
    pageInputEl.value?.focus()
    pageInputEl.value?.select()
    event.preventDefault()
    return
  }
  if (key === '+' || key === '=') {
    zoomBy(1)
    event.preventDefault()
    return
  }
  if (key === '-') {
    zoomBy(-1)
    event.preventDefault()
    return
  }
  if (lower === 'z') {
    cycleZoomMode()
    event.preventDefault()
    return
  }
  if (lower === 'c') {
    readerContinuous.value = !readerContinuous.value
    event.preventDefault()
    return
  }
  if (key === '[') {
    rotation.value = (rotation.value + 270) % 360
    event.preventDefault()
    return
  }
  if (key === ']') {
    rotation.value = (rotation.value + 90) % 360
    event.preventDefault()
    return
  }
  if (event.shiftKey && lower === 'i') {
    inverted.value = !inverted.value
    event.preventDefault()
    return
  }
  if (lower === 'f') {
    toggleFullscreen()
    event.preventDefault()
    return
  }
  if (key === 'Home') {
    navigateToPage(1, { history: false })
    event.preventDefault()
    return
  }
  if (key === 'End') {
    navigateToPage(doc.value.pageCount, { history: false })
    event.preventDefault()
    return
  }
  if (key === ' ' || key === 'PageDown' || key === 'PageUp') {
    const direction = key === 'PageUp' || event.shiftKey ? -1 : 1
    if (readerContinuous.value) viewerEl.value?.scrollBy({ top: direction * viewerEl.value.clientHeight * 0.88, behavior: 'smooth' })
    else navigateRelative(direction)
    event.preventDefault()
    return
  }
  if (lower === 'n') {
    navigateRelative(1)
    event.preventDefault()
    return
  }
  if (lower === 'p') {
    navigateRelative(-1)
    event.preventDefault()
    return
  }
  if (key === 'ArrowDown' || lower === 'j') {
    viewerEl.value?.scrollBy({ top: 48 })
    event.preventDefault()
    return
  }
  if (key === 'ArrowUp' || lower === 'k') {
    viewerEl.value?.scrollBy({ top: -48 })
    event.preventDefault()
    return
  }
  if (key === 'ArrowRight' || lower === 'l') {
    if (viewerEl.value?.scrollWidth > viewerEl.value?.clientWidth + 4) viewerEl.value.scrollBy({ left: event.shiftKey ? 260 : 56 })
    else navigateRelative(1)
    event.preventDefault()
    return
  }
  if (key === 'ArrowLeft' || lower === 'h') {
    if (viewerEl.value?.scrollWidth > viewerEl.value?.clientWidth + 4) viewerEl.value.scrollBy({ left: event.shiftKey ? -260 : -56 })
    else navigateRelative(-1)
    event.preventDefault()
  }
}

// ---------- Thumbnails (Page Management) ----------
const selected = ref(new Set())
let thumbObserver = null

function setupThumbObserver() {
  thumbObserver?.disconnect()
  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) renderThumb(+en.target.dataset.thumb)
      }
    },
    { root: viewerEl.value, rootMargin: '400px 0px' }
  )
  viewerEl.value?.querySelectorAll('[data-thumb]').forEach((el) => thumbObserver.observe(el))
}

async function renderThumb(i) {
  if (thumbRendered.has(i) || !doc.value) return
  thumbRendered.add(i)
  try {
    const page = await doc.value.pdf.getPage(i + 1)
    const base = page.getViewport({ scale: 1 })
    const scale = (150 * (window.devicePixelRatio || 1)) / base.width
    const vp = page.getViewport({ scale })
    const cv = viewerEl.value?.querySelector(`canvas[data-tcv="${i}"]`)
    if (!cv) return
    cv.width = Math.round(vp.width)
    cv.height = Math.round(vp.height)
    await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise
  } catch {
    thumbRendered.delete(i)
  }
}

function toggleSelect(i) {
  const s = new Set(selected.value)
  s.has(i) ? s.delete(i) : s.add(i)
  selected.value = s
}

function selectAll(flag) {
  selected.value = flag ? new Set(Array.from({ length: doc.value.pageCount }, (_, i) => i)) : new Set()
}

// ---------- Watermark Settings & Live Preview ----------
const wm = reactive({
  type: 'text',
  text: 'Internal Document - Do Not Distribute',
  imagePath: '',
  color: 'gray',
  sizePct: 5,
  opacity: 26,
  angle: -30,
  tile: true,
  density: 'normal',
  mode: 'layer',
  dpi: 200,
  range: '',
})
let wmImageBitmap = null
const previewUrl = ref('')

async function pickWmImage() {
  const path = await openDialog({ multiple: false, title: 'Select watermark image', filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] })
  if (typeof path !== 'string') return
  wm.imagePath = path
  const bytes = await readFile(path)
  wmImageBitmap = await createImageBitmap(new Blob([bytes]))
  refreshPreview()
}

let previewTimer = null
function refreshPreview() {
  clearTimeout(previewTimer)
  previewTimer = setTimeout(() => {
    if (tool.value !== 'watermark' || !doc.value) {
      previewUrl.value = ''
      return
    }
    if (wm.type === 'image' && !wmImageBitmap) {
      previewUrl.value = ''
      return
    }
    const { w, h } = doc.value.sizes[0]
    const cv = makeOverlayCanvas(w, h, { ...wm, imageBitmap: wmImageBitmap }, 1.5)
    previewUrl.value = cv.toDataURL('image/png')
  }, 160)
}

watch(wm, refreshPreview)

// ---------- Merge Documents ----------
const mergeList = ref([])

async function addMergeFiles() {
  const paths = await openDialog({ multiple: true, title: 'Add PDF', filters: [{ name: 'PDF Document', extensions: ['pdf'] }] })
  if (!paths) return
  for (const p of Array.isArray(paths) ? paths : [paths]) {
    if (!mergeList.value.some((x) => x.path === p)) {
      mergeList.value.push({ path: p, name: p.split(/[/\\]/).pop() })
    }
  }
}

function moveMerge(i, dir) {
  const j = i + dir
  if (j < 0 || j >= mergeList.value.length) return
  const arr = [...mergeList.value]
  ;[arr[i], arr[j]] = [arr[j], arr[i]]
  mergeList.value = arr
}

// ---------- Export Images / Compression Settings ----------
const exp = reactive({ format: 'png', dpi: 200, range: '' })
const cmp = reactive({ dpi: 150, quality: 0.8 })
const prot = reactive({ pw: '', pw2: '', noPrint: false, noCopy: false })

async function applyProtect() {
  await runTask(async () => {
    const d = doc.value
    if (!prot.pw) throw new Error('Please enter open password')
    if (prot.pw !== prot.pw2) throw new Error('Passwords do not match')
    busyStart('Encrypting document', 1)
    const bytes = await encryptPdf(d.bytes, prot.pw, { noPrint: prot.noPrint, noCopy: prot.noCopy }, d.password)
    const out = await outputPath(d.path, '_encrypted')
    const size = await saveBytes(out, bytes)
    lastResult.value = { label: 'Encrypted, please keep the password safe', path: out, extra: fmtSize(size) }
    prot.pw = ''
    prot.pw2 = ''
  })
}

async function applyUnlock() {
  await runTask(async () => {
    const d = doc.value
    if (!d.password) throw new Error('Document has no open password, decryption not needed')
    busyStart('Removing password', 1)
    const bytes = await decryptPdf(d.bytes, d.password)
    const out = await outputPath(d.path, '_decrypted')
    const size = await saveBytes(out, bytes)
    lastResult.value = { label: 'Output password-free copy', path: out, extra: fmtSize(size) }
  })
}

// ---------- Task Execution ----------
function busyStart(stage, total) {
  busy.active = true
  busy.stage = stage
  busy.done = 0
  busy.total = total
}
function busyEnd() {
  busy.active = false
}

async function runTask(fn) {
  errorMsg.value = ''
  lastResult.value = null
  try {
    await fn()
  } catch (e) {
    errorMsg.value = String(e.message || e)
  } finally {
    busyEnd()
  }
}

const fmtSize = (b) => (!b ? '-' : b >= 1 << 20 ? (b / (1 << 20)).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB')

async function applyWatermark() {
  await runTask(async () => {
    const d = doc.value
    if (wm.type === 'text' && !wm.text.trim()) throw new Error('Please enter watermark text')
    if (wm.type === 'image' && !wmImageBitmap) throw new Error('Please select a watermark image first')
    const range = parseRange(wm.range, d.pageCount)
    const opts = { ...wm, imageBitmap: wmImageBitmap }
    busyStart(wm.mode === 'layer' ? 'Adding layer watermark' : 'Rasterizing (unremovable watermark)', range.size)
    const onP = (n) => (busy.done = n)
    const bytes =
      wm.mode === 'layer'
        ? await watermarkLayer(d.bytes, d.pdf, range, opts, onP, d.password)
        : await watermarkRaster(d.bytes, d.pdf, range, opts, wm.dpi, 0.86, onP, d.password)
    const out = await outputPath(d.path, '_watermarked')
    const size = await saveBytes(out, bytes)
    lastResult.value = { label: 'Watermark added', path: out, extra: fmtSize(size) }
  })
}

async function applyPages(action) {
  await runTask(async () => {
    const d = doc.value
    const sel = selected.value
    if (sel.size === 0) throw new Error('Select pages in thumbnails first')
    busyStart('Processing pages', 1)
    let bytes, suffix
    if (action === 'extract') {
      bytes = await extractPages(d.bytes, sel, d.password)
      suffix = '_extracted'
    } else if (action === 'delete') {
      if (sel.size >= d.pageCount) throw new Error('Cannot delete all pages')
      const keep = new Set(Array.from({ length: d.pageCount }, (_, i) => i).filter((i) => !sel.has(i)))
      bytes = await extractPages(d.bytes, keep, d.password)
      suffix = '_deleted'
    } else {
      bytes = await rotatePages(d.bytes, sel, 90, d.password)
      suffix = '_rotated'
    }
    const out = await outputPath(d.path, suffix)
    const size = await saveBytes(out, bytes)
    lastResult.value = { label: 'New file exported', path: out, extra: fmtSize(size) }
  })
}

async function applyMerge() {
  await runTask(async () => {
    if (mergeList.value.length < 2) throw new Error('At least two PDFs are required to merge')
    busyStart('Merging documents', mergeList.value.length)
    const bytes = await mergePdfs(mergeList.value.map((x) => x.path), (n) => (busy.done = n))
    const out = await outputPath(mergeList.value[0].path, '_merged')
    const size = await saveBytes(out, bytes)
    lastResult.value = { label: `Merged ${mergeList.value.length} documents`, path: out, extra: fmtSize(size) }
  })
}

async function applyExport() {
  await runTask(async () => {
    const d = doc.value
    const range = parseRange(exp.range, d.pageCount)
    busyStart('Exporting images', range.size)
    const outs = await exportImages(d.pdf, range, exp.dpi, exp.format, 0.9, d.path, (n) => (busy.done = n))
    lastResult.value = { label: `Exported ${outs.length} images`, path: outs[0], extra: '' }
  })
}

async function applyCompress() {
  await runTask(async () => {
    const d = doc.value
    busyStart('Rasterization compression', d.pageCount)
    const bytes = await compressPdf(d.pdf, cmp.dpi, cmp.quality, (n) => (busy.done = n))
    const out = await outputPath(d.path, '_compressed')
    const size = await saveBytes(out, bytes)
    const pct = Math.round((1 - size / d.size) * 100)
    lastResult.value = {
      label: pct > 0 ? `Compression completed, reduced by ${pct}%` : 'Compression completed (original file is already compact)',
      path: out,
      extra: `${fmtSize(d.size)} → ${fmtSize(size)}`,
    }
  })
}

// ---------- Drag & Drop and Lifecycle ----------
let unlistenDrop = null

// Demo mode: ?demo=<tool> loads sample document without Tauri dependencies
const DEMO = new URLSearchParams(location.search).get('demo')

async function seedDemo(t) {
  if (t === 'pwcard') {
    pwPrompt.show = true
    pwPrompt.name = 'Board_Minutes-Confidential.pdf'
    return
  }
  const res = await fetch('/demo.pdf')
  const raw = new Uint8Array(await res.arrayBuffer())
  const { bytes, pdf } = await openPdfBytes(raw)
  const sizes = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const vp = (await pdf.getPage(i)).getViewport({ scale: 1 })
    sizes.push({ w: vp.width, h: vp.height })
  }
  doc.value = {
    path: '/demo/Product_Whitepaper-2026.pdf', name: 'Product_Whitepaper-2026.pdf',
    size: 2836582, bytes, pdf, pageCount: pdf.numPages, sizes,
    pageLabels: await pdf.getPageLabels().catch(() => null), password: '',
  }
  outlineItems.value = flattenOutline((await pdf.getOutline().catch(() => null)) || [])
  currentPage.value = 1
  pageField.value = '1'
  navHistory.value = [1]
  navHistoryIndex.value = 0
  mergeList.value = [
    { path: '/demo/Product_Whitepaper-2026.pdf', name: 'Product_Whitepaper-2026.pdf' },
    { path: '/demo/Appendix_A-Financials.pdf', name: 'Appendix_A-Financials.pdf' },
    { path: '/demo/Appendix_B-User_Research.pdf', name: 'Appendix_B-User_Research.pdf' },
  ]
  if (t && t !== 'read') tool.value = t
  if (t === 'pages') selected.value = new Set([1, 3, 4])
  if (t === 'protect') Object.assign(prot, { pw: 'demo-1234', pw2: 'demo-1234', noPrint: true, noCopy: true })
  if (t === 'watermark') wm.opacity = 30
  await nextTick()
  zoomFit()
  await nextTick()
  // Render eagerly in headless screenshot environment
  if (tool.value === 'pages') {
    for (let i = 0; i < pdf.numPages; i++) await renderThumb(i)
  } else {
    for (let i = 0; i < Math.min(3, pdf.numPages); i++) await renderPage(i)
  }
  refreshPreview()
  document.title = 'DEMO_READY'
}

onMounted(async () => {
  window.addEventListener('resize', onResize)
  window.addEventListener('keydown', handleKeydown)
  document.addEventListener('fullscreenchange', onFullscreenChange)
  if (DEMO) {
    seedDemo(DEMO)
    return
  }
  unlistenDrop = await getCurrentWebview().onDragDropEvent((event) => {
    const t = event.payload.type
    if (t === 'drop') {
      dragging.value = false
      const pdfs = event.payload.paths.filter((p) => p.toLowerCase().endsWith('.pdf'))
      if (!pdfs.length) return
      if (tool.value === 'merge') {
        for (const p of pdfs) {
          if (!mergeList.value.some((x) => x.path === p)) {
            mergeList.value.push({ path: p, name: p.split(/[/\\]/).pop() })
          }
        }
      } else {
        loadDoc(pdfs[0])
      }
    } else if (t === 'leave') {
      dragging.value = false
    } else {
      dragging.value = true
    }
  })
})

function onResize() {
  if (doc.value && zoomMode.value !== 'custom') invalidateRendering(80)
  if ('__TAURI_INTERNALS__' in window) {
    getCurrentWindow().isFullscreen().then((value) => {
      fullscreen.value = value
      if (!value && presentation.value) onFullscreenChange()
    }).catch(() => {})
  }
}

function onFullscreenChange() {
  fullscreen.value = !!document.fullscreenElement
  if (!fullscreen.value && presentation.value) {
    presentation.value = false
    if (presentationRestore) {
      pageLayout.value = presentationRestore.layout
      readerContinuous.value = presentationRestore.continuous
      zoomMode.value = presentationRestore.zoomMode
      zoom.value = presentationRestore.zoom
    }
  }
}

onBeforeUnmount(() => {
  saveReaderState()
  clearTimeout(saveStateTimer)
  clearTimeout(searchTimer)
  clearTimeout(zoomTimer)
  unlistenDrop?.()
  observer?.disconnect()
  thumbObserver?.disconnect()
  readerThumbObserver?.disconnect()
  window.removeEventListener('resize', onResize)
  window.removeEventListener('keydown', handleKeydown)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
})

const toolMeta = computed(() => NAV.find((n) => n.id === tool.value))

// Empty state copy for each tool when no document is open
const emptyCopy = computed(() => {
  const map = {
    read: 'Drag and drop a PDF file, or click to open',
    watermark: 'Drag PDF here to add watermark, or click to open',
    pages: 'Drag PDF here to manage pages',
    export: 'Drag PDF here to export as images',
    compress: 'Drag PDF here to compress',
    protect: 'Drag PDF here to encrypt',
    unlock: 'Drag PDF here to decrypt (requires password)',
  }
  return map[tool.value] || map.read
})
</script>

<template>
  <div class="app" :class="{ dragging, fullscreen, presentation, 'reader-inverted': inverted && tool === 'read' }">
    <!-- Sidebar -->
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-logo" v-html="ICONS.brand"></span>
        <div>
          <div class="brand-name">Nexus PDF</div>
          <div class="brand-sub">Nexus PDF</div>
        </div>
      </div>

      <nav class="nav">
        <button
          v-for="n in NAV"
          :key="n.id"
          class="nav-item"
          :class="{ active: tool === n.id }"
          @click="tool = n.id"
        >
          <span class="nav-icon" v-html="ICONS[{ read: 'read', pages: 'pages', merge: 'merge', export: 'image', compress: 'compress', protect: 'lock', unlock: 'unlock' }[n.id] || 'watermark']"></span>
          <span class="nav-label">{{ n.name }}</span>
        </button>
      </nav>

      <div class="sidebar-foot">
        <div>Nexus PDF</div>
        <div class="sidebar-foot-sub">Nexus PDF</div>
      </div>
    </aside>

    <!-- Main Area -->
    <main class="content">
      <div v-if="errorMsg" class="alert">{{ errorMsg }}</div>
      <div v-if="lastResult" class="result-bar">
        <span class="badge success">{{ lastResult.label }}</span>
        <span class="result-name">{{ lastResult.path.split(/[/\\]/).pop() }}</span>
        <span class="result-extra">{{ lastResult.extra }}</span>
        <button class="btn ghost small" @click="revealFile(lastResult.path)">Show File</button>
      </div>

      <!-- No Document Opened -->
      <div v-if="!doc" class="empty">
        <!-- Encrypted Document: Password Prompt -->
        <div v-if="pwPrompt.show" class="pw-card">
          <span class="dropzone-icon pw-icon" v-html="ICONS.lock"></span>
          <div class="pw-title">'{{ pwPrompt.name }}' is password protected</div>
          <div class="pw-hint" :class="{ wrong: pwPrompt.wrong }">
            {{ pwPrompt.wrong ? 'Incorrect password, please try again' : 'Enter password to continue' }}
          </div>
          <input
            class="tinput"
            type="password"
            v-model="pwPrompt.value"
            placeholder="Open Password"
            @keyup.enter="submitPassword"
            autofocus
          />
          <div class="pw-actions">
            <button class="btn ghost" @click="pwPrompt.show = false">Cancel</button>
            <button class="btn primary" :disabled="!pwPrompt.value" @click="submitPassword">Unlock</button>
          </div>
        </div>

        <!-- Merge: Standalone workspace without open document -->
        <div v-else-if="tool === 'merge'" class="merge-standalone">
          <div class="panel-head">
            <h2>Merge PDF</h2>
            <p>Combine multiple PDFs sequentially into one file, drag into window or click to add</p>
          </div>
          <div class="merge-list" v-if="mergeList.length">
            <div v-for="(m, i) in mergeList" :key="m.path" class="merge-item">
              <span class="merge-idx">{{ i + 1 }}</span>
              <span class="merge-name" :title="m.path">{{ m.name }}</span>
              <button class="mini" @click="moveMerge(i, -1)">↑</button>
              <button class="mini" @click="moveMerge(i, 1)">↓</button>
              <button class="mini danger" @click="mergeList.splice(i, 1)">×</button>
            </div>
          </div>
          <button class="btn ghost wide" @click="addMergeFiles">
            <span class="btn-icon" v-html="ICONS.plus"></span>Add PDF
          </button>
          <button class="btn primary wide" :disabled="mergeList.length < 2" @click="applyMerge">
            Merge {{ mergeList.length }} documents
          </button>
        </div>

        <!-- Other Tools: File open guide -->
        <div v-else class="dropzone" @click="pickAndOpen">
          <span class="dropzone-icon" v-html="ICONS[{ read: 'read', pages: 'pages', export: 'image', compress: 'compress', protect: 'lock', unlock: 'unlock' }[tool] || 'watermark']"></span>
          <div class="dropzone-title">{{ emptyCopy }}</div>
          <div class="dropzone-hint">Read · Watermark (Layer/Raster) · Pages · Merge · Export · Compress — All done locally</div>
        </div>
      </div>

      <template v-else>
        <!-- Header -->
        <header class="topbar">
          <div class="doc-info">
            <div class="doc-name" :title="doc.path">{{ doc.name }}</div>
            <div class="doc-meta">
              {{ doc.pageCount }} Pages · {{ fmtSize(doc.size) }}
              <template v-if="tool === 'read'"> · Current {{ currentPageLabel }}</template>
            </div>
          </div>
          <div v-if="tool !== 'read'" class="topbar-mid">
            <span class="page-ind">{{ currentPage }} / {{ doc.pageCount }}</span>
            <div class="zoom-ctl">
              <button class="zbtn" @click="zoomBy(-1)">−</button>
              <span class="zval">{{ Math.round(zoom * 100) }}%</span>
              <button class="zbtn" @click="zoomBy(1)">+</button>
              <button class="zbtn fit" @click="zoomFit">Fit Width</button>
            </div>
          </div>
          <div class="topbar-actions">
            <button class="btn ghost" @click="pickAndOpen">Switch Document</button>
            <button class="btn ghost quiet" @click="closeDoc" title="Close">
              <span class="btn-icon" v-html="ICONS.close"></span>
            </button>
          </div>
        </header>

        <!-- Reader Toolbar -->
        <div v-if="tool === 'read'" class="readerbar">
          <div class="readerbar-group">
            <button
              class="toolbtn"
              :class="{ active: readerSidebar === 'outline' }"
              title="Show/Hide Outline (F12)"
              @click="readerSidebar = readerSidebar === 'outline' ? 'none' : 'outline'"
            >
              <span v-html="ICONS.outline"></span>
            </button>
            <button
              class="toolbtn"
              :class="{ active: readerSidebar === 'thumbs' }"
              title="Show/Hide Thumbnails"
              @click="readerSidebar = readerSidebar === 'thumbs' ? 'none' : 'thumbs'"
            >
              <span v-html="ICONS.thumbnails"></span>
            </button>
          </div>

          <div class="readerbar-group">
            <button class="toolbtn" :disabled="!canNavigateBack" title="Back (⌥←)" @click="navigateHistory(-1)">
              <span v-html="ICONS.back"></span>
            </button>
            <button class="toolbtn" :disabled="!canNavigateForward" title="Forward (⌥→)" @click="navigateHistory(1)">
              <span v-html="ICONS.forward"></span>
            </button>
          </div>

          <div class="readerbar-group page-jump">
            <button class="toolbtn" title="Previous Page (Page Up)" @click="navigateRelative(-1)">
              <span v-html="ICONS.chevronLeft"></span>
            </button>
            <input
              ref="pageInputEl"
              v-model="pageField"
              class="page-input"
              aria-label="Page Number"
              @focus="$event.target.select()"
              @keydown.enter.prevent="submitPageField"
              @blur="pageField = String(currentPage)"
            />
            <span class="page-total">/ {{ doc.pageCount }}</span>
            <button class="toolbtn" title="Next Page (Page Down)" @click="navigateRelative(1)">
              <span v-html="ICONS.chevronRight"></span>
            </button>
          </div>

          <div class="readerbar-group zoom-group">
            <button class="toolbtn" title="Zoom Out (−)" @click="zoomBy(-1)">
              <span v-html="ICONS.minus"></span>
            </button>
            <select
              class="toolbar-select zoom-select"
              :value="zoomMode"
              :title="`${zoomLabel} · ${zoomPercent}%`"
              @change="setZoomMode($event.target.value)"
            >
              <option value="fit-page">Fit Page</option>
              <option value="fit-width">Fit Width</option>
              <option value="fit-content">Fit Content</option>
              <option value="custom">{{ zoomPercent }}%</option>
            </select>
            <button class="toolbtn" title="Zoom In (+)" @click="zoomBy(1)">
              <span v-html="ICONS.plus"></span>
            </button>
          </div>

          <div class="readerbar-group">
            <button class="toolbtn" :class="{ active: pageLayout === 'single' }" title="Single Page (⌘6)" @click="pageLayout = 'single'">
              <span v-html="ICONS.singlePage"></span>
            </button>
            <button class="toolbtn" :class="{ active: pageLayout === 'facing' }" title="Facing (⌘7)" @click="pageLayout = 'facing'">
              <span v-html="ICONS.facing"></span>
            </button>
            <button class="toolbtn" :class="{ active: pageLayout === 'book' }" title="Book View (⌘8)" @click="pageLayout = 'book'">
              <span v-html="ICONS.book"></span>
            </button>
            <button class="toolbtn" :class="{ active: readerContinuous }" title="Continuous Mode (C)" @click="readerContinuous = !readerContinuous">
              <span v-html="ICONS.continuous"></span>
            </button>
          </div>

          <div class="readerbar-spacer"></div>
          <div class="readerbar-group">
            <button class="toolbtn" title="Rotate Left ([)" @click="rotation = (rotation + 270) % 360">
              <span v-html="ICONS.rotateLeft"></span>
            </button>
            <button class="toolbtn" title="Rotate Right (])" @click="rotation = (rotation + 90) % 360">
              <span v-html="ICONS.rotateRight"></span>
            </button>
            <button class="toolbtn" title="Find (⌘F)" @click="openFind">
              <span v-html="ICONS.search"></span>
            </button>
            <button class="toolbtn" title="Fullscreen (F11)" @click="toggleFullscreen()">
              <span v-html="ICONS.fullscreen"></span>
            </button>
          </div>
        </div>

        <div class="workspace">
          <!-- Outline / Thumbnails Sidebar -->
          <aside v-if="tool === 'read' && readerSidebar !== 'none'" class="reader-side">
            <div class="reader-side-head">
              <button :class="{ active: readerSidebar === 'outline' }" @click="readerSidebar = 'outline'">Outline</button>
              <button :class="{ active: readerSidebar === 'thumbs' }" @click="readerSidebar = 'thumbs'">Thumbnails</button>
              <button class="reader-side-close" title="Close Sidebar" @click="readerSidebar = 'none'">×</button>
            </div>
            <div ref="readerSidebarEl" class="reader-side-body">
              <template v-if="readerSidebar === 'outline'">
                <button
                  v-for="(item, index) in outlineItems"
                  :key="index"
                  class="outline-item"
                  :style="{ paddingLeft: `${12 + item.level * 15}px` }"
                  :class="{ bold: item.bold, italic: item.italic }"
                  :title="item.title"
                  @click="activateOutline(item)"
                >
                  {{ item.title }}
                </button>
                <div v-if="!outlineItems.length" class="side-empty">This document has no outline</div>
              </template>
              <template v-else>
                <button
                  v-for="(size, index) in doc.sizes"
                  :key="index"
                  class="reader-thumb"
                  :class="{ active: currentPage === index + 1 }"
                  :data-reader-thumb="index"
                  @click="navigateToPage(index + 1)"
                >
                  <span class="reader-thumb-paper">
                    <canvas :data-reader-thumb-canvas="index"></canvas>
                  </span>
                  <span>{{ doc.pageLabels?.[index] || index + 1 }}</span>
                </button>
              </template>
            </div>
          </aside>

          <!-- In-Document Search -->
          <div v-if="tool === 'read' && findState.open" class="findbar">
            <span class="find-icon" v-html="ICONS.search"></span>
            <input
              ref="findInputEl"
              v-model="findState.query"
              placeholder="Find in document"
              spellcheck="false"
              @keydown.enter.prevent="findNext($event.shiftKey ? -1 : 1)"
            />
            <span class="find-count">{{ findCounter }}</span>
            <button title="Previous (⇧F3)" @click="findNext(-1)" v-html="ICONS.chevronUp"></button>
            <button title="Next (F3)" @click="findNext(1)" v-html="ICONS.chevronDown"></button>
            <button title="Close (Esc)" @click="closeFind" v-html="ICONS.close"></button>
          </div>

          <!-- Reader / Thumbnail Canvas -->
          <div
            class="viewer"
            :class="{ panning: panState.active, paged: tool === 'read' && !readerContinuous }"
            ref="viewerEl"
            tabindex="0"
            @scroll.passive="trackCurrentPage"
            @wheel="onViewerWheel"
            @pointerdown="startPan"
            @pointermove="movePan"
            @pointerup="endPan"
            @pointercancel="endPan"
            @contextmenu="onViewerContextMenu"
          >
            <!-- Page Management: Thumbnail Grid -->
            <div v-if="tool === 'pages'" class="thumb-grid">
              <div
                v-for="(s, i) in doc.sizes"
                :key="'t' + i"
                class="thumb"
                :class="{ picked: selected.has(i) }"
                :data-thumb="i"
                @click="toggleSelect(i)"
              >
                <canvas :data-tcv="i"></canvas>
                <span class="thumb-num">{{ i + 1 }}</span>
                <span class="thumb-check">✓</span>
              </div>
            </div>

            <!-- Single / Facing / Book x Continuous / Discrete -->
            <div
              v-else
              class="pages"
              :class="{
                'non-continuous': tool === 'read' && !readerContinuous,
                'two-page': tool === 'read' && pageLayout !== 'single',
              }"
            >
              <div v-for="row in readerRows" :key="row.join('-')" class="page-row">
                <div
                  v-for="i in row"
                  :key="i"
                  class="page"
                  :class="{ current: tool === 'read' && currentPage === i + 1 }"
                  :data-page="i"
                  :style="pageStyle(doc.sizes[i], i)"
                >
                  <canvas :data-cv="i"></canvas>
                  <div v-if="tool === 'read'" class="search-layer" :data-search-layer="i"></div>
                  <div v-if="tool === 'read'" class="textLayer" :data-text-layer="i"></div>
                  <div v-if="tool === 'read'" class="annotation-layer" :data-annotation-layer="i"></div>
                  <img
                    v-if="tool === 'watermark' && previewUrl"
                    class="wm-preview"
                    :src="previewUrl"
                    alt=""
                  />
                  <span class="page-num">{{ doc.pageLabels?.[i] || i + 1 }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Tool Panels -->
          <aside v-if="tool !== 'read'" class="panel">
            <div class="panel-head">
              <h2>{{ toolMeta.name }}</h2>
              <p>{{ toolMeta.desc }}</p>
            </div>

            <!-- Watermark -->
            <template v-if="tool === 'watermark'">
              <div class="field">
                <div class="field-label">Watermark Type</div>
                <div class="segmented">
                  <button :class="{ active: wm.type === 'text' }" @click="wm.type = 'text'">Text</button>
                  <button :class="{ active: wm.type === 'image' }" @click="wm.type = 'image'">Image</button>
                </div>
              </div>
              <div class="field" v-if="wm.type === 'text'">
                <div class="field-label">Watermark Text</div>
                <input class="tinput" v-model="wm.text" placeholder="Internal Document - Do Not Distribute" spellcheck="false" />
              </div>
              <div class="field" v-else>
                <div class="field-label">Watermark Image</div>
                <div class="file-row">
                  <button class="btn ghost small" @click="pickWmImage">Select Image</button>
                  <span class="file-name" :class="{ empty: !wm.imagePath }">{{ wm.imagePath ? wm.imagePath.split(/[/\\]/).pop() : 'Not Selected' }}</span>
                </div>
              </div>
              <div class="field" v-if="wm.type === 'text'">
                <div class="field-label">Color</div>
                <div class="segmented">
                  <button v-for="c in [['gray', 'Gray'], ['red', 'Red'], ['blue', 'Blue'], ['black', 'Black']]" :key="c[0]" :class="{ active: wm.color === c[0] }" @click="wm.color = c[0]">{{ c[1] }}</button>
                </div>
              </div>
              <div class="field">
                <div class="field-label">Size {{ wm.sizePct }}%</div>
                <input type="range" min="2" max="30" v-model.number="wm.sizePct" />
              </div>
              <div class="field">
                <div class="field-label">Opacity {{ wm.opacity }}%</div>
                <input type="range" min="5" max="80" v-model.number="wm.opacity" />
              </div>
              <div class="field">
                <div class="field-label">Angle {{ wm.angle }}°</div>
                <input type="range" min="-90" max="90" step="15" v-model.number="wm.angle" />
              </div>
              <div class="field">
                <div class="field-label">Layout</div>
                <div class="segmented">
                  <button :class="{ active: wm.tile }" @click="wm.tile = true">Tile</button>
                  <button :class="{ active: !wm.tile }" @click="wm.tile = false">Center Single</button>
                </div>
              </div>
              <div class="field" v-if="wm.tile">
                <div class="field-label">Density</div>
                <div class="segmented">
                  <button v-for="x in [['sparse', 'Sparse'], ['normal', 'Normal'], ['dense', 'Dense']]" :key="x[0]" :class="{ active: wm.density === x[0] }" @click="wm.density = x[0]">{{ x[1] }}</button>
                </div>
              </div>
              <div class="field">
                <div class="field-label">Mode</div>
                <div class="segmented">
                  <button :class="{ active: wm.mode === 'layer' }" @click="wm.mode = 'layer'">Layer</button>
                  <button :class="{ active: wm.mode === 'raster' }" @click="wm.mode = 'raster'">Anti-deletion</button>
                </div>
                <div class="field-hint">{{ wm.mode === 'layer' ? 'Watermark is superimposed as a layer, file size barely increases, text remains copyable' : 'Full page rasterized, watermark merged into pixels and cannot be removed; text becomes unselectable, file size increases' }}</div>
              </div>
              <div class="field" v-if="wm.mode === 'raster'">
                <div class="field-label">Resolution</div>
                <div class="segmented">
                  <button v-for="d in [150, 200, 300]" :key="d" :class="{ active: wm.dpi === d }" @click="wm.dpi = d">{{ d }} DPI</button>
                </div>
              </div>
              <div class="field">
                <div class="field-label">Page Range</div>
                <input class="tinput" v-model.trim="wm.range" placeholder="All pages (e.g. 1-3,5)" spellcheck="false" />
              </div>
              <button class="btn primary wide" @click="applyWatermark">Add Watermark</button>
            </template>

            <!-- Page Management -->
            <template v-else-if="tool === 'pages'">
              <div class="field">
                <div class="field-label">Selected {{ selected.size }} / {{ doc.pageCount }} Pages</div>
                <div class="segmented">
                  <button @click="selectAll(true)">Select All</button>
                  <button @click="selectAll(false)">Clear</button>
                </div>
                <div class="field-hint">Click left thumbnails to check pages</div>
              </div>
              <button class="btn primary wide" @click="applyPages('extract')">Extract selected → New PDF</button>
              <button class="btn ghost wide" @click="applyPages('delete')">Delete selected → New PDF</button>
              <button class="btn ghost wide" @click="applyPages('rotate')">Rotate selected 90°</button>
              <div class="field-hint pad-top">All operations output to a new file, the original document is untouched</div>
            </template>

            <!-- Merge -->
            <template v-else-if="tool === 'merge'">
              <div class="merge-list">
                <div v-for="(m, i) in mergeList" :key="m.path" class="merge-item">
                  <span class="merge-idx">{{ i + 1 }}</span>
                  <span class="merge-name" :title="m.path">{{ m.name }}</span>
                  <button class="mini" @click="moveMerge(i, -1)">↑</button>
                  <button class="mini" @click="moveMerge(i, 1)">↓</button>
                  <button class="mini danger" v-if="mergeList.length > 1" @click="mergeList.splice(i, 1)">×</button>
                </div>
              </div>
              <button class="btn ghost wide" @click="addMergeFiles">
                <span class="btn-icon" v-html="ICONS.plus"></span>Add PDF
              </button>
              <button class="btn primary wide" @click="applyMerge">Merge {{ mergeList.length }} documents</button>
              <div class="field-hint pad-top">You can also drag PDFs directly into the window to add them to the list</div>
            </template>

            <!-- Export to Images -->
            <template v-else-if="tool === 'export'">
              <div class="field">
                <div class="field-label">Image Format</div>
                <div class="segmented">
                  <button :class="{ active: exp.format === 'png' }" @click="exp.format = 'png'">PNG</button>
                  <button :class="{ active: exp.format === 'jpg' }" @click="exp.format = 'jpg'">JPG</button>
                </div>
              </div>
              <div class="field">
                <div class="field-label">Resolution</div>
                <div class="segmented">
                  <button v-for="d in [150, 200, 300]" :key="d" :class="{ active: exp.dpi === d }" @click="exp.dpi = d">{{ d }} DPI</button>
                </div>
              </div>
              <div class="field">
                <div class="field-label">Page Range</div>
                <input class="tinput" v-model.trim="exp.range" placeholder="All pages (e.g. 1-3,5)" spellcheck="false" />
              </div>
              <button class="btn primary wide" @click="applyExport">Export Images</button>
              <div class="field-hint pad-top">Images are saved next to the original document, numbered by page</div>
            </template>

            <!-- Encrypt -->
            <template v-else-if="tool === 'protect'">
              <div class="field">
                <div class="field-label">Open Password</div>
                <input class="tinput" type="password" v-model="prot.pw" placeholder="Set Open Password" />
              </div>
              <div class="field">
                <div class="field-label">Confirm Password</div>
                <input class="tinput" type="password" v-model="prot.pw2" placeholder="Enter again" @keyup.enter="applyProtect" />
              </div>
              <div class="field">
                <div class="field-label">Permission Restrictions</div>
                <div class="segmented">
                  <button :class="{ active: prot.noPrint }" @click="prot.noPrint = !prot.noPrint">Disable Printing</button>
                  <button :class="{ active: prot.noCopy }" @click="prot.noCopy = !prot.noCopy">Disable Copying</button>
                </div>
                <div class="field-hint">AES encryption. If the password is lost, there is no backdoor to retrieve it, please remember it carefully</div>
              </div>
              <button class="btn primary wide" @click="applyProtect">Output Encrypted</button>
            </template>

            <!-- Decrypt -->
            <template v-else-if="tool === 'unlock'">
              <div class="field" v-if="doc.password">
                <div class="field-label">Current document is unlocked with password</div>
                <div class="field-hint">Output a password-free copy, which anyone can open directly later</div>
              </div>
              <div class="field" v-else>
                <div class="field-label">Current document has no open password</div>
                <div class="field-hint">No decryption needed. To process an encrypted file, simply open it and enter the password</div>
              </div>
              <button class="btn primary wide" :disabled="!doc.password" @click="applyUnlock">Output without Password</button>
            </template>

            <!-- Compress -->
            <template v-else-if="tool === 'compress'">
              <div class="field">
                <div class="field-label">Resolution</div>
                <div class="segmented">
                  <button v-for="d in [[110, 'Smaller'], [150, 'Balanced'], [200, 'Sharper']]" :key="d[0]" :class="{ active: cmp.dpi === d[0] }" @click="cmp.dpi = d[0]">{{ d[1] }}</button>
                </div>
                <div class="field-hint">Full page rasterization reconstruction, suitable for scanned documents; text in text-based PDFs will become unselectable after compression</div>
              </div>
              <button class="btn primary wide" @click="applyCompress">Start Compression</button>
            </template>
          </aside>
        </div>
      </template>
    </main>

    <!-- Drag Overlay -->
    <div v-if="dragging" class="drag-overlay">
      <div class="drag-overlay-text">Release to Nexus PDF</div>
    </div>

    <!-- Task Progress -->
    <div v-if="busy.active" class="busy-mask">
      <div class="busy-box">
        <div class="busy-stage">{{ busy.stage }}</div>
        <div class="progress-bar">
          <div class="progress-fill" :style="{ width: busy.total ? (busy.done / busy.total) * 100 + '%' : '30%' }"></div>
        </div>
        <div class="busy-count" v-if="busy.total > 1">{{ busy.done }} / {{ busy.total }} Pages</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app {
  height: 100vh;
  display: flex;
  overflow: hidden;
}

/* Sidebar */
.sidebar {
  width: 190px;
  flex-shrink: 0;
  background: #fff;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  padding: 20px 12px 16px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 0 10px 18px;
}
.brand-logo {
  width: 38px;
  height: 38px;
  filter: drop-shadow(0 3px 8px rgba(22, 100, 255, 0.35));
}
.brand-logo :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}
.brand-name {
  letter-spacing: -0.5px;
  font-weight: 700;
  background: linear-gradient(135deg, #5E5CE6, #7c7be0);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  font-size: 17px;
  font-weight: 700;
  line-height: 1.2;
}
.brand-sub {
  font-size: 11px;
  color: var(--text-3);
  letter-spacing: 0.04em;
}
.nav {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8.5px 12px;
  border-radius: var(--radius);
  font-size: 13.5px;
  color: var(--text-2);
  transition: background 0.18s, color 0.18s, transform 0.12s;
  text-align: left;
}
.nav-item:hover:not(:disabled) {
  background: var(--fill-1);
  color: var(--text-1);
}
.nav-item:active:not(:disabled) {
  transform: scale(0.98);
}
.nav-item.active {
  background: var(--primary-light);
  color: var(--primary);
  font-weight: 600;
}
.nav-item:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.nav-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}
.nav-icon :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}
.sidebar-foot {
  padding: 12px 10px 0;
  border-top: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-2);
}
.sidebar-foot-sub {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 1px;
}

/* Main Area */
.content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.empty {
  flex: 1;
  display: flex;
  padding: 40px;
  align-items: stretch;
  justify-content: center;
}
.merge-standalone {
  align-self: center;
  width: min(460px, 100%);
  background: #fff;
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  padding: 24px 22px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.pw-card {
  align-self: center;
  width: min(400px, 100%);
  background: #fff;
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  padding: 28px 26px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
  text-align: center;
}
.pw-icon {
  margin-bottom: 2px;
}
.pw-title {
  font-size: 15px;
  font-weight: 600;
  word-break: break-all;
}
.pw-hint {
  font-size: 12px;
  color: var(--text-3);
}
.pw-hint.wrong {
  color: var(--danger);
}
.pw-card .tinput {
  text-align: center;
}
.pw-actions {
  display: flex;
  gap: 10px;
  margin-top: 4px;
}

.merge-standalone .btn.primary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  box-shadow: none;
  transform: none;
}
.dropzone {
  flex: 1;
  border: 1.5px dashed #cfd8e8;
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.55);
  transition: border-color 0.2s, background 0.2s;
}
.dropzone:hover,
.app.dragging .dropzone {
  border-color: var(--primary);
  background: var(--primary-lighter);
}
.dropzone-icon {
  width: 56px;
  height: 56px;
  color: var(--primary);
  background: var(--primary-light);
  border-radius: 18px;
  padding: 13px;
  margin-bottom: 8px;
}
.dropzone-icon :deep(svg) {
  width: 100%;
  height: 100%;
}
.dropzone-title {
  font-size: 16px;
  font-weight: 600;
}
.dropzone-hint {
  font-size: 12px;
  color: var(--text-3);
}

/* Header */
.topbar {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 10px 18px;
  background: #fff;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.doc-info {
  min-width: 0;
  flex: 1;
}
.doc-name {
  font-size: 13.5px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.doc-meta {
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.topbar-mid {
  display: flex;
  align-items: center;
  gap: 14px;
}
.page-ind {
  font-size: 12px;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
  background: var(--fill-2);
  padding: 3px 10px;
  border-radius: 99px;
}
.zoom-ctl {
  display: flex;
  align-items: center;
  gap: 2px;
  background: var(--fill-2);
  border-radius: 8px;
  padding: 2px;
}
.zbtn {
  width: 26px;
  height: 24px;
  border-radius: 6px;
  font-size: 14px;
  color: var(--text-2);
  transition: all 0.15s;
}
.zbtn.fit {
  width: auto;
  padding: 0 8px;
  font-size: 12px;
}
.zbtn:hover {
  background: #fff;
  color: var(--primary);
}
.zval {
  font-size: 12px;
  color: var(--text-2);
  width: 44px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.topbar-actions {
  display: flex;
  gap: 8px;
}

/* Reader Toolbar */
.readerbar {
  min-height: 42px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 10px;
  background: #fff;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.readerbar::-webkit-scrollbar {
  display: none;
}
.readerbar-group {
  display: flex;
  align-items: center;
  gap: 2px;
  padding-right: 7px;
  border-right: 1px solid var(--border);
  flex-shrink: 0;
}
.readerbar-group:last-child {
  padding-right: 0;
  border-right: 0;
}
.readerbar-spacer {
  flex: 1;
  min-width: 8px;
}
.toolbtn {
  width: 29px;
  height: 29px;
  border-radius: 6px;
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s;
}
.toolbtn:hover:not(:disabled),
.toolbtn.active {
  color: var(--primary);
  background: var(--primary-light);
}
.toolbtn:disabled {
  opacity: 0.3;
  cursor: default;
}
.toolbtn > span {
  width: 17px;
  height: 17px;
  display: block;
}
.toolbtn > span :deep(svg),
.find-icon :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}
.page-jump {
  gap: 3px;
}
.page-input {
  width: 44px;
  height: 27px;
  padding: 0 6px;
  text-align: center;
  border: 1px solid var(--border);
  box-shadow: 0 2px 8px rgba(0,0,0,0.02);
  border-radius: 6px;
  color: var(--text-1);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  background: #fff;
}
.page-input:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 2px rgba(22, 100, 255, 0.11);
}
.page-total {
  min-width: 30px;
  color: var(--text-3);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.toolbar-select {
  height: 27px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.toolbar-select:hover {
  background: var(--fill-1);
}
.zoom-select {
  width: 88px;
  padding: 0 5px;
}

.alert {
  margin: 10px 18px 0;
  background: var(--danger-light);
  color: var(--danger);
  padding: 10px 14px;
  border-radius: var(--radius);
  font-size: 13px;
}
.result-bar {
  margin: 10px 18px 0;
  background: #fff;
  border-radius: var(--radius);
  box-shadow: var(--shadow-card);
  padding: 9px 14px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.result-name {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.result-extra {
  color: var(--text-3);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.result-bar .btn {
  margin-left: auto;
  flex-shrink: 0;
}
.badge {
  font-size: 12px;
  padding: 1.5px 9px;
  border-radius: 5px;
  flex-shrink: 0;
}
.badge.success {
  color: var(--success);
  background: var(--success-light);
  font-weight: 500;
}

/* Workspace */
.workspace {
  flex: 1;
  display: flex;
  min-height: 0;
  position: relative;
}
.reader-side {
  width: 224px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: #fff;
  border-right: 1px solid var(--border);
}
.reader-side-head {
  height: 38px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 5px 7px;
  border-bottom: 1px solid var(--border);
}
.reader-side-head button {
  padding: 4px 9px;
  border-radius: 5px;
  color: var(--text-3);
  font-size: 12px;
}
.reader-side-head button.active {
  color: var(--primary);
  background: var(--primary-light);
  font-weight: 600;
}
.reader-side-head .reader-side-close {
  width: 25px;
  height: 25px;
  margin-left: auto;
  padding: 0;
  font-size: 18px;
}
.reader-side-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 7px;
}
.outline-item {
  width: 100%;
  display: block;
  padding-top: 6px;
  padding-right: 8px;
  padding-bottom: 6px;
  border-radius: 6px;
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.35;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.outline-item:hover {
  color: var(--primary);
  background: var(--primary-lighter);
}
.outline-item.bold {
  font-weight: 700;
}
.outline-item.italic {
  font-style: italic;
}
.side-empty {
  color: var(--text-3);
  font-size: 12px;
  text-align: center;
  padding: 32px 10px;
}
.reader-thumb {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 7px 6px;
  border-radius: 7px;
  color: var(--text-3);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.reader-thumb:hover {
  background: var(--fill-1);
}
.reader-thumb.active {
  color: var(--primary);
  background: var(--primary-light);
}
.reader-thumb-paper {
  width: 132px;
  min-height: 54px;
  display: block;
  background: #fff;
  box-shadow: 0 1px 4px rgba(26, 34, 51, 0.18);
}
.reader-thumb-paper canvas {
  width: 100%;
  display: block;
}
.findbar {
  position: absolute;
  top: 10px;
  right: 14px;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 38px;
  padding: 4px 5px 4px 10px;
  background: rgba(255, 255, 255, 0.97);
  border: 1px solid var(--border);
  box-shadow: 0 2px 8px rgba(0,0,0,0.02);
  border-radius: 9px;
  box-shadow: 0 8px 28px rgba(26, 34, 51, 0.18);
}
.find-icon {
  width: 15px;
  height: 15px;
  color: var(--text-3);
}
.findbar input {
  width: 190px;
  border: 0;
  outline: 0;
  color: var(--text-1);
  background: transparent;
  font-size: 13px;
}
.find-count {
  min-width: 52px;
  color: var(--text-3);
  font-size: 11px;
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.findbar button {
  width: 27px;
  height: 27px;
  padding: 5px;
  border-radius: 5px;
  color: var(--text-2);
}
.findbar button:hover {
  color: var(--primary);
  background: var(--primary-light);
}
.findbar button :deep(svg) {
  width: 100%;
  height: 100%;
}
.viewer {
  flex: 1;
  overflow: auto;
  padding: 22px 0 40px;
  background: #eef0f3;
  outline: none;
  overscroll-behavior: contain;
}
.viewer.panning {
  cursor: grabbing;
  user-select: none;
}
.pages {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}
.pages.non-continuous {
  min-width: min-content;
  min-height: 100%;
  justify-content: center;
  padding: 12px 28px;
}
.page-row {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  gap: 14px;
  min-width: min-content;
}
.page {
  position: relative;
  background: #fff;
  box-shadow: 0 1px 3px rgba(26, 34, 51, 0.09), 0 6px 22px rgba(26, 34, 51, 0.07);
  border-radius: 3px;
  overflow: hidden;
  flex: 0 0 auto;
}
.page canvas {
  width: 100%;
  height: 100%;
  display: block;
}
.search-layer,
.annotation-layer,
.textLayer {
  position: absolute;
  inset: 0;
}
.search-layer {
  z-index: 1;
  pointer-events: none;
}
.search-highlight {
  position: absolute;
  border-radius: 2px;
  background: rgba(255, 175, 42, 0.38);
  box-shadow: inset 0 0 0 1px rgba(215, 132, 0, 0.18);
}
.search-highlight.active {
  background: rgba(71, 145, 255, 0.46);
  box-shadow: inset 0 0 0 1px rgba(22, 100, 255, 0.45);
}
.textLayer {
  z-index: 2;
}
.annotation-layer {
  z-index: 3;
  pointer-events: none;
}
.annotation-layer :deep(.pdf-link) {
  position: absolute;
  display: block;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  pointer-events: auto;
}
.annotation-layer :deep(.pdf-link:hover) {
  background: rgba(22, 100, 255, 0.09);
  box-shadow: inset 0 0 0 1px rgba(22, 100, 255, 0.32);
}
.wm-preview {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.page-num {
  position: absolute;
  right: 8px;
  bottom: 6px;
  font-size: 10.5px;
  color: var(--text-3);
  background: rgba(255, 255, 255, 0.85);
  padding: 1px 7px;
  border-radius: 99px;
  font-variant-numeric: tabular-nums;
  z-index: 4;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.15s;
}
.page:hover .page-num,
.page.current .page-num {
  opacity: 1;
}

/* Thumbnails */
.thumb-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 14px;
  padding: 0 22px;
}
.thumb {
  position: relative;
  background: #fff;
  border-radius: 8px;
  box-shadow: var(--shadow-card);
  border: 2px solid transparent;
  cursor: pointer;
  overflow: hidden;
  transition: border-color 0.15s, transform 0.15s;
}
.thumb:hover {
  transform: translateY(-2px);
}
.thumb.picked {
  border-color: var(--primary);
}
.thumb canvas {
  width: 100%;
  display: block;
  min-height: 80px;
}
.thumb-num {
  position: absolute;
  left: 7px;
  bottom: 6px;
  font-size: 11px;
  color: var(--text-2);
  background: rgba(255, 255, 255, 0.9);
  padding: 0 7px;
  border-radius: 99px;
  font-variant-numeric: tabular-nums;
}
.thumb-check {
  position: absolute;
  right: 7px;
  top: 7px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--primary);
  color: #fff;
  font-size: 12px;
  display: none;
  align-items: center;
  justify-content: center;
}
.thumb.picked .thumb-check {
  display: flex;
}

/* Tool Panels */
.panel {
  width: 280px;
  flex-shrink: 0;
  background: #fff;
  border-left: 1px solid var(--border);
  overflow-y: auto;
  padding: 20px 18px 24px;
  display: flex;
  flex-direction: column;
  gap: 15px;
}
.panel-head h2 {
  font-size: 16px;
  font-weight: 700;
}
.panel-head p {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 3px;
  line-height: 1.5;
}
.field-label {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-2);
  margin-bottom: 7px;
  font-variant-numeric: tabular-nums;
}
.field-hint {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 6px;
  line-height: 1.5;
}
.field-hint.pad-top {
  margin-top: 2px;
}
.field input[type='range'] {
  width: 100%;
  accent-color: var(--primary);
  cursor: pointer;
}
.tinput {
  width: 100%;
  padding: 7px 11px;
  border: 1px solid var(--border);
  box-shadow: 0 2px 8px rgba(0,0,0,0.02);
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text-1);
  transition: border-color 0.16s, box-shadow 0.16s;
}
.tinput:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(22, 100, 255, 0.12);
  outline: none;
}
.segmented {
  display: flex;
  background: var(--fill-2);
  border-radius: var(--radius-sm);
  padding: 3px;
  gap: 2px;
}
.segmented button {
  flex: 1;
  padding: 5px 4px;
  font-size: 12px;
  border-radius: 5px;
  color: var(--text-2);
  transition: all 0.16s;
  white-space: nowrap;
}
.segmented button.active {
  background: #fff;
  color: var(--primary);
  font-weight: 600;
  box-shadow: 0 1px 4px rgba(26, 34, 51, 0.1);
}
.file-row {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}
.file-name {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.file-name.empty {
  color: var(--text-3);
}

/* Merge List */
.merge-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.merge-item {
  display: flex;
  align-items: center;
  gap: 7px;
  background: var(--fill-1);
  border-radius: 8px;
  padding: 7px 10px;
  font-size: 12.5px;
}
.merge-idx {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--primary-light);
  color: var(--primary);
  font-size: 11px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.merge-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mini {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  color: var(--text-3);
  font-size: 12px;
  transition: all 0.15s;
  flex-shrink: 0;
}
.mini:hover {
  background: #fff;
  color: var(--primary);
}
.mini.danger:hover {
  color: var(--danger);
  background: var(--danger-light);
}

/* Buttons */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 7px 16px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  transition: all 0.16s;
}
.btn:active {
  transform: scale(0.97);
}
.btn.primary {
  background: var(--primary);
  color: #fff;
  font-weight: 500;
  box-shadow: var(--shadow-pop);
}
.btn.primary:hover {
  background: var(--primary-hover);
  transform: translateY(-1px);
}
.btn.ghost {
  color: var(--text-2);
  background: #fff;
  border: 1px solid var(--border);
  box-shadow: 0 2px 8px rgba(0,0,0,0.02);
}
.btn.ghost:hover {
  color: var(--primary);
  border-color: rgba(22, 100, 255, 0.4);
}
.btn.small {
  padding: 4px 11px;
  font-size: 12px;
}
.btn.wide {
  width: 100%;
}
.btn.quiet {
  border-color: transparent;
  color: var(--text-3);
  padding: 7px 9px;
}
.btn.quiet:hover {
  color: var(--danger);
  background: var(--danger-light);
  border-color: transparent;
}
.btn-icon {
  width: 13px;
  height: 13px;
}
.btn-icon :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}

/* Overlays */
.drag-overlay {
  position: fixed;
  inset: 10px;
  background: rgba(22, 100, 255, 0.07);
  backdrop-filter: blur(2px);
  border: 2px dashed var(--primary);
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  z-index: 50;
}
.drag-overlay-text {
  font-size: 19px;
  font-weight: 600;
  color: var(--primary);
  background: #fff;
  padding: 14px 34px;
  border-radius: 14px;
  box-shadow: 0 12px 40px rgba(22, 100, 255, 0.28);
}

.busy-mask {
  position: fixed;
  inset: 0;
  background: rgba(16, 22, 36, 0.45);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.busy-box {
  background: #fff;
  border-radius: 14px;
  padding: 22px 28px;
  width: 340px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: 0 24px 80px rgba(10, 20, 40, 0.35);
}
.busy-stage {
  font-size: 14px;
  font-weight: 600;
}
.progress-bar {
  height: 6px;
  background: var(--fill-2);
  border-radius: 99px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #3d7fff, var(--primary));
  border-radius: 99px;
  transition: width 0.3s ease;
}
.busy-count {
  font-size: 12px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

/* Fullscreen preserves reader toolbar; demo mode preserves pages only */
.app.fullscreen > .sidebar,
.app.presentation > .sidebar {
  display: none;
}
.app.presentation .topbar,
.app.presentation .readerbar,
.app.presentation .reader-side,
.app.presentation .findbar {
  display: none;
}
.app.presentation .viewer {
  padding: 0;
  background: #16181c;
}
.app.presentation .pages.non-continuous {
  padding: 0;
}
.app.presentation .page {
  box-shadow: none;
  border-radius: 0;
}
.app.presentation .page-num {
  display: none;
}
.app.reader-inverted .viewer {
  background: #16181c;
}
.app.reader-inverted .page {
  background: #000;
}
.app.reader-inverted .page canvas {
  filter: invert(1);
}
</style>
