<script setup>
import { ref, shallowRef, reactive, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { readFile } from '@tauri-apps/plugin-fs'
import {
  openPdf, openPdfBytes, parseRange, makeOverlayCanvas,
  watermarkLayer, watermarkRaster, extractPages, rotatePages, mergePdfs,
  exportImages, compressPdf, encryptPdf, decryptPdf,
  saveBytes, outputPath, fileSize, revealFile,
} from './pdfops.js'
import { ICONS } from './icons.js'

const NAV = [
  { id: 'read', name: '阅读', desc: '连续滚动浏览文档' },
  { id: 'watermark', name: '加水印', desc: '文字或图片水印，图层与防删除栅格双模式' },
  { id: 'pages', name: '页面管理', desc: '勾选页面后提取、删除或旋转，输出为新文件' },
  { id: 'merge', name: '合并 PDF', desc: '多个 PDF 按顺序合成一个文件' },
  { id: 'export', name: '转图片', desc: '把页面导出为 PNG 或 JPG 图片' },
  { id: 'compress', name: '压缩 PDF', desc: '整页栅格化重建，大幅缩小扫描件体积' },
  { id: 'protect', name: '加密', desc: '设置打开密码，可附加禁止打印、禁止复制的权限限制' },
  { id: 'unlock', name: '解密', desc: '用已知密码打开后，输出一份无密码副本' },
]

const tool = ref('read')
const doc = shallowRef(null) // { path, name, size, bytes, pdf, pageCount, sizes:[{w,h}] }
const errorMsg = ref('')
const dragging = ref(false)
const lastResult = ref(null) // { label, path, extra }
const busy = reactive({ active: false, stage: '', done: 0, total: 0 })
const pwPrompt = reactive({ show: false, path: '', name: '', value: '', wrong: false })

// ---------- 打开文档 ----------
async function pickAndOpen() {
  const path = await openDialog({ multiple: false, title: '打开 PDF', filters: [{ name: 'PDF 文档', extensions: ['pdf'] }] })
  if (typeof path === 'string') await loadDoc(path)
}

async function loadDoc(path, password) {
  errorMsg.value = ''
  lastResult.value = null
  try {
    busyStart('正在打开文档', 1)
    const { bytes, pdf } = await openPdf(path, password)
    pwPrompt.show = false
    pwPrompt.value = ''
    const sizes = []
    for (let i = 1; i <= pdf.numPages; i++) {
      const vp = (await pdf.getPage(i)).getViewport({ scale: 1 })
      sizes.push({ w: vp.width, h: vp.height })
    }
    doc.value = {
      path,
      name: path.split(/[/\\]/).pop(),
      size: await fileSize(path),
      bytes, pdf,
      pageCount: pdf.numPages,
      sizes,
      password: password || '',
    }
    renderVersion++
    renderedSet.clear()
    thumbRendered.clear()
    selected.value = new Set()
    if (!mergeList.value.some((x) => x.path === path)) {
      mergeList.value.unshift({ path, name: doc.value.name })
    }
    zoomFit()
    await nextTick()
    if (tool.value === 'pages') setupThumbObserver()
    else setupObserver()
  } catch (e) {
    if (e?.name === 'PasswordException' || /password/i.test(String(e?.name || e))) {
      // 加密文档: 弹出密码输入, 输对后重新加载
      pwPrompt.show = true
      pwPrompt.path = path
      pwPrompt.name = path.split(/[/\\]/).pop()
      pwPrompt.wrong = !!password
      doc.value = null
    } else {
      errorMsg.value = '打开失败：' + (e.message || e)
    }
  } finally {
    busyEnd()
  }
}

function submitPassword() {
  if (pwPrompt.value) loadDoc(pwPrompt.path, pwPrompt.value)
}

function closeDoc() {
  doc.value?.pdf?.destroy()
  doc.value = null
  lastResult.value = null
  observer?.disconnect()
}

// ---------- 阅读器渲染 (懒加载 + 缩放) ----------
const viewerEl = ref(null)
const zoom = ref(1.2)
const currentPage = ref(1)
let observer = null
let renderVersion = 0
const renderedSet = new Set() // `${index}@${version}`
const thumbRendered = new Set()

function zoomFit() {
  if (!doc.value || !viewerEl.value) {
    zoom.value = 1.2
    return
  }
  const maxW = Math.max(...doc.value.sizes.map((s) => s.w))
  zoom.value = Math.max(0.3, (viewerEl.value.clientWidth - 72) / maxW)
}

function zoomBy(f) {
  zoom.value = Math.min(4, Math.max(0.3, zoom.value * f))
}

let zoomTimer = null
watch(zoom, () => {
  clearTimeout(zoomTimer)
  zoomTimer = setTimeout(() => {
    renderVersion++
    renderedSet.clear()
    reobserve()
  }, 220)
})

watch(tool, async () => {
  errorMsg.value = ''
  await nextTick()
  if (tool.value === 'pages') setupThumbObserver()
  else if (doc.value) {
    // 文档可能是在「页面管理」下打开的, 此时滚动视图的观察器还没建过
    observer ? reobserve() : setupObserver()
  }
  refreshPreview()
})

function setupObserver() {
  observer?.disconnect()
  observer = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) renderPage(+en.target.dataset.page)
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

async function renderPage(i) {
  const d = doc.value
  if (!d) return
  const key = `${i}@${renderVersion}`
  if (renderedSet.has(key)) return
  renderedSet.add(key)
  const ver = renderVersion
  try {
    const page = await d.pdf.getPage(i + 1)
    if (ver !== renderVersion) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const vp = page.getViewport({ scale: zoom.value * dpr })
    const cv = viewerEl.value?.querySelector(`canvas[data-cv="${i}"]`)
    if (!cv) return
    cv.width = Math.round(vp.width)
    cv.height = Math.round(vp.height)
    await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise
    cv.dataset.ok = '1'
  } catch {
    renderedSet.delete(key)
  }
}

function trackCurrentPage() {
  const root = viewerEl.value
  if (!root || !doc.value) return
  const mid = root.scrollTop + root.clientHeight / 3
  let acc = 0
  for (let i = 0; i < doc.value.sizes.length; i++) {
    acc += doc.value.sizes[i].h * zoom.value + 14
    if (acc > mid) {
      currentPage.value = i + 1
      return
    }
  }
}

// ---------- 缩略图 (页面管理) ----------
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

// ---------- 水印设置与实时预览 ----------
const wm = reactive({
  type: 'text',
  text: '内部资料 请勿外传',
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
  const path = await openDialog({ multiple: false, title: '选择水印图片', filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] })
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

// ---------- 合并 ----------
const mergeList = ref([])

async function addMergeFiles() {
  const paths = await openDialog({ multiple: true, title: '添加 PDF', filters: [{ name: 'PDF 文档', extensions: ['pdf'] }] })
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

// ---------- 转图片 / 压缩 设置 ----------
const exp = reactive({ format: 'png', dpi: 200, range: '' })
const cmp = reactive({ dpi: 150, quality: 0.8 })
const prot = reactive({ pw: '', pw2: '', noPrint: false, noCopy: false })

async function applyProtect() {
  await runTask(async () => {
    const d = doc.value
    if (!prot.pw) throw new Error('请输入打开密码')
    if (prot.pw !== prot.pw2) throw new Error('两次输入的密码不一致')
    busyStart('加密文档', 1)
    const bytes = await encryptPdf(d.bytes, prot.pw, { noPrint: prot.noPrint, noCopy: prot.noCopy }, d.password)
    const out = await outputPath(d.path, '_加密')
    const size = await saveBytes(out, bytes)
    lastResult.value = { label: '已加密，请妥善保管密码', path: out, extra: fmtSize(size) }
    prot.pw = ''
    prot.pw2 = ''
  })
}

async function applyUnlock() {
  await runTask(async () => {
    const d = doc.value
    if (!d.password) throw new Error('当前文档没有打开密码，无需解密')
    busyStart('移除密码', 1)
    const bytes = await decryptPdf(d.bytes, d.password)
    const out = await outputPath(d.path, '_解密')
    const size = await saveBytes(out, bytes)
    lastResult.value = { label: '已输出无密码副本', path: out, extra: fmtSize(size) }
  })
}

// ---------- 任务执行 ----------
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
    if (wm.type === 'text' && !wm.text.trim()) throw new Error('请输入水印文字')
    if (wm.type === 'image' && !wmImageBitmap) throw new Error('请先选择水印图片')
    const range = parseRange(wm.range, d.pageCount)
    const opts = { ...wm, imageBitmap: wmImageBitmap }
    busyStart(wm.mode === 'layer' ? '添加图层水印' : '栅格化重建(无法移除的水印)', range.size)
    const onP = (n) => (busy.done = n)
    const bytes =
      wm.mode === 'layer'
        ? await watermarkLayer(d.bytes, d.pdf, range, opts, onP, d.password)
        : await watermarkRaster(d.bytes, d.pdf, range, opts, wm.dpi, 0.86, onP, d.password)
    const out = await outputPath(d.path, '_水印')
    const size = await saveBytes(out, bytes)
    lastResult.value = { label: '水印已添加', path: out, extra: fmtSize(size) }
  })
}

async function applyPages(action) {
  await runTask(async () => {
    const d = doc.value
    const sel = selected.value
    if (sel.size === 0) throw new Error('先在缩略图上勾选页面')
    busyStart('处理页面', 1)
    let bytes, suffix
    if (action === 'extract') {
      bytes = await extractPages(d.bytes, sel, d.password)
      suffix = '_提取'
    } else if (action === 'delete') {
      if (sel.size >= d.pageCount) throw new Error('不能删除全部页面')
      const keep = new Set(Array.from({ length: d.pageCount }, (_, i) => i).filter((i) => !sel.has(i)))
      bytes = await extractPages(d.bytes, keep, d.password)
      suffix = '_删页'
    } else {
      bytes = await rotatePages(d.bytes, sel, 90, d.password)
      suffix = '_旋转'
    }
    const out = await outputPath(d.path, suffix)
    const size = await saveBytes(out, bytes)
    lastResult.value = { label: '已输出新文件', path: out, extra: fmtSize(size) }
  })
}

async function applyMerge() {
  await runTask(async () => {
    if (mergeList.value.length < 2) throw new Error('至少需要两个 PDF 才能合并')
    busyStart('合并文档', mergeList.value.length)
    const bytes = await mergePdfs(mergeList.value.map((x) => x.path), (n) => (busy.done = n))
    const out = await outputPath(mergeList.value[0].path, '_合并')
    const size = await saveBytes(out, bytes)
    lastResult.value = { label: `已合并 ${mergeList.value.length} 个文档`, path: out, extra: fmtSize(size) }
  })
}

async function applyExport() {
  await runTask(async () => {
    const d = doc.value
    const range = parseRange(exp.range, d.pageCount)
    busyStart('导出图片', range.size)
    const outs = await exportImages(d.pdf, range, exp.dpi, exp.format, 0.9, d.path, (n) => (busy.done = n))
    lastResult.value = { label: `已导出 ${outs.length} 张图片`, path: outs[0], extra: '' }
  })
}

async function applyCompress() {
  await runTask(async () => {
    const d = doc.value
    busyStart('栅格化压缩', d.pageCount)
    const bytes = await compressPdf(d.pdf, cmp.dpi, cmp.quality, (n) => (busy.done = n))
    const out = await outputPath(d.path, '_压缩')
    const size = await saveBytes(out, bytes)
    const pct = Math.round((1 - size / d.size) * 100)
    lastResult.value = {
      label: pct > 0 ? `压缩完成，瘦身 ${pct}%` : '压缩完成(原文件已很紧凑)',
      path: out,
      extra: `${fmtSize(d.size)} → ${fmtSize(size)}`,
    }
  })
}

// ---------- 拖拽与生命周期 ----------
let unlistenDrop = null

// 演示模式: ?demo=<tool> 加载内置示例文档, 供文档截图, 不依赖 Tauri
const DEMO = new URLSearchParams(location.search).get('demo')

async function seedDemo(t) {
  if (t === 'pwcard') {
    pwPrompt.show = true
    pwPrompt.name = '董事会纪要-机密.pdf'
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
    path: '/demo/产品白皮书-2026.pdf', name: '产品白皮书-2026.pdf',
    size: 2836582, bytes, pdf, pageCount: pdf.numPages, sizes, password: '',
  }
  mergeList.value = [
    { path: '/demo/产品白皮书-2026.pdf', name: '产品白皮书-2026.pdf' },
    { path: '/demo/附录A-财务数据.pdf', name: '附录A-财务数据.pdf' },
    { path: '/demo/附录B-用户调研.pdf', name: '附录B-用户调研.pdf' },
  ]
  if (t && t !== 'read') tool.value = t
  if (t === 'pages') selected.value = new Set([1, 3, 4])
  if (t === 'protect') Object.assign(prot, { pw: 'demo-1234', pw2: 'demo-1234', noPrint: true, noCopy: true })
  if (t === 'watermark') wm.opacity = 30
  await nextTick()
  zoomFit()
  await nextTick()
  // 截图环境里 IntersectionObserver 不可靠: 直接急切渲染
  if (tool.value === 'pages') {
    for (let i = 0; i < pdf.numPages; i++) await renderThumb(i)
  } else {
    for (let i = 0; i < Math.min(3, pdf.numPages); i++) await renderPage(i)
  }
  refreshPreview()
  document.title = 'DEMO_READY'
}

onMounted(async () => {
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
  window.addEventListener('resize', onResize)
})

function onResize() {
  // 适宽模式下随窗口重排
}

onBeforeUnmount(() => {
  unlistenDrop?.()
  observer?.disconnect()
  thumbObserver?.disconnect()
  window.removeEventListener('resize', onResize)
})

const toolMeta = computed(() => NAV.find((n) => n.id === tool.value))

// 未打开文档时, 各工具的空状态文案
const emptyCopy = computed(() => {
  const map = {
    read: '拖入 PDF 文件，或点击打开',
    watermark: '拖入要加水印的 PDF，或点击打开',
    pages: '拖入 PDF，开始管理页面',
    export: '拖入 PDF，导出为图片',
    compress: '拖入要压缩的 PDF',
    protect: '拖入要加密的 PDF',
    unlock: '拖入要解密的 PDF（需要知道它的密码）',
  }
  return map[tool.value] || map.read
})
</script>

<template>
  <div class="app" :class="{ dragging }">
    <!-- 侧栏 -->
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-logo" v-html="ICONS.brand"></span>
        <div>
          <div class="brand-name">轻卷</div>
          <div class="brand-sub">LightScroll</div>
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
        <div>云中江树</div>
        <div class="sidebar-foot-sub">微信公众号「云中江树」</div>
      </div>
    </aside>

    <!-- 主区 -->
    <main class="content">
      <div v-if="errorMsg" class="alert">{{ errorMsg }}</div>
      <div v-if="lastResult" class="result-bar">
        <span class="badge success">{{ lastResult.label }}</span>
        <span class="result-name">{{ lastResult.path.split(/[/\\]/).pop() }}</span>
        <span class="result-extra">{{ lastResult.extra }}</span>
        <button class="btn ghost small" @click="revealFile(lastResult.path)">显示文件</button>
      </div>

      <!-- 未打开文档 -->
      <div v-if="!doc" class="empty">
        <!-- 加密文档: 密码输入 -->
        <div v-if="pwPrompt.show" class="pw-card">
          <span class="dropzone-icon pw-icon" v-html="ICONS.lock"></span>
          <div class="pw-title">「{{ pwPrompt.name }}」有密码保护</div>
          <div class="pw-hint" :class="{ wrong: pwPrompt.wrong }">
            {{ pwPrompt.wrong ? '密码不对，再试一次' : '输入打开密码继续' }}
          </div>
          <input
            class="tinput"
            type="password"
            v-model="pwPrompt.value"
            placeholder="打开密码"
            @keyup.enter="submitPassword"
            autofocus
          />
          <div class="pw-actions">
            <button class="btn ghost" @click="pwPrompt.show = false">取消</button>
            <button class="btn primary" :disabled="!pwPrompt.value" @click="submitPassword">解锁打开</button>
          </div>
        </div>

        <!-- 合并不需要先开文档: 直接给独立工作区 -->
        <div v-else-if="tool === 'merge'" class="merge-standalone">
          <div class="panel-head">
            <h2>合并 PDF</h2>
            <p>把多个 PDF 按顺序合成一个文件，拖进窗口或点击添加</p>
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
            <span class="btn-icon" v-html="ICONS.plus"></span>添加 PDF
          </button>
          <button class="btn primary wide" :disabled="mergeList.length < 2" @click="applyMerge">
            合并 {{ mergeList.length }} 个文档
          </button>
        </div>

        <!-- 其余工具: 带工具语境的打开引导 -->
        <div v-else class="dropzone" @click="pickAndOpen">
          <span class="dropzone-icon" v-html="ICONS[{ read: 'read', pages: 'pages', export: 'image', compress: 'compress', protect: 'lock', unlock: 'unlock' }[tool] || 'watermark']"></span>
          <div class="dropzone-title">{{ emptyCopy }}</div>
          <div class="dropzone-hint">阅读 · 加水印(图层/防删除) · 页面管理 · 合并 · 转图片 · 压缩 — 全部本地完成</div>
        </div>
      </div>

      <template v-else>
        <!-- 顶栏 -->
        <header class="topbar">
          <div class="doc-info">
            <div class="doc-name" :title="doc.path">{{ doc.name }}</div>
            <div class="doc-meta">{{ doc.pageCount }} 页 · {{ fmtSize(doc.size) }}</div>
          </div>
          <div class="topbar-mid">
            <span class="page-ind">{{ currentPage }} / {{ doc.pageCount }}</span>
            <div class="zoom-ctl">
              <button class="zbtn" @click="zoomBy(1 / 1.2)">−</button>
              <span class="zval">{{ Math.round(zoom * 100) }}%</span>
              <button class="zbtn" @click="zoomBy(1.2)">+</button>
              <button class="zbtn fit" @click="zoomFit">适宽</button>
            </div>
          </div>
          <div class="topbar-actions">
            <button class="btn ghost" @click="pickAndOpen">换文档</button>
            <button class="btn ghost quiet" @click="closeDoc" title="关闭">
              <span class="btn-icon" v-html="ICONS.close"></span>
            </button>
          </div>
        </header>

        <div class="workspace">
          <!-- 阅读区 / 缩略图区 -->
          <div class="viewer" ref="viewerEl" @scroll.passive="trackCurrentPage">
            <!-- 页面管理: 缩略图网格 -->
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

            <!-- 连续滚动阅读 -->
            <div v-else class="pages">
              <div
                v-for="(s, i) in doc.sizes"
                :key="i"
                class="page"
                :data-page="i"
                :style="{ width: s.w * zoom + 'px', height: s.h * zoom + 'px' }"
              >
                <canvas :data-cv="i"></canvas>
                <img
                  v-if="tool === 'watermark' && previewUrl"
                  class="wm-preview"
                  :src="previewUrl"
                  alt=""
                />
                <span class="page-num">{{ i + 1 }}</span>
              </div>
            </div>
          </div>

          <!-- 工具面板 -->
          <aside v-if="tool !== 'read'" class="panel">
            <div class="panel-head">
              <h2>{{ toolMeta.name }}</h2>
              <p>{{ toolMeta.desc }}</p>
            </div>

            <!-- 水印 -->
            <template v-if="tool === 'watermark'">
              <div class="field">
                <div class="field-label">水印类型</div>
                <div class="segmented">
                  <button :class="{ active: wm.type === 'text' }" @click="wm.type = 'text'">文字</button>
                  <button :class="{ active: wm.type === 'image' }" @click="wm.type = 'image'">图片</button>
                </div>
              </div>
              <div class="field" v-if="wm.type === 'text'">
                <div class="field-label">水印文字</div>
                <input class="tinput" v-model="wm.text" placeholder="内部资料 请勿外传" spellcheck="false" />
              </div>
              <div class="field" v-else>
                <div class="field-label">水印图片</div>
                <div class="file-row">
                  <button class="btn ghost small" @click="pickWmImage">选择图片</button>
                  <span class="file-name" :class="{ empty: !wm.imagePath }">{{ wm.imagePath ? wm.imagePath.split(/[/\\]/).pop() : '未选择' }}</span>
                </div>
              </div>
              <div class="field" v-if="wm.type === 'text'">
                <div class="field-label">颜色</div>
                <div class="segmented">
                  <button v-for="c in [['gray', '灰'], ['red', '红'], ['blue', '蓝'], ['black', '黑']]" :key="c[0]" :class="{ active: wm.color === c[0] }" @click="wm.color = c[0]">{{ c[1] }}</button>
                </div>
              </div>
              <div class="field">
                <div class="field-label">大小 {{ wm.sizePct }}%</div>
                <input type="range" min="2" max="30" v-model.number="wm.sizePct" />
              </div>
              <div class="field">
                <div class="field-label">不透明度 {{ wm.opacity }}%</div>
                <input type="range" min="5" max="80" v-model.number="wm.opacity" />
              </div>
              <div class="field">
                <div class="field-label">角度 {{ wm.angle }}°</div>
                <input type="range" min="-90" max="90" step="15" v-model.number="wm.angle" />
              </div>
              <div class="field">
                <div class="field-label">布局</div>
                <div class="segmented">
                  <button :class="{ active: wm.tile }" @click="wm.tile = true">平铺</button>
                  <button :class="{ active: !wm.tile }" @click="wm.tile = false">居中单个</button>
                </div>
              </div>
              <div class="field" v-if="wm.tile">
                <div class="field-label">密度</div>
                <div class="segmented">
                  <button v-for="x in [['sparse', '疏'], ['normal', '中'], ['dense', '密']]" :key="x[0]" :class="{ active: wm.density === x[0] }" @click="wm.density = x[0]">{{ x[1] }}</button>
                </div>
              </div>
              <div class="field">
                <div class="field-label">模式</div>
                <div class="segmented">
                  <button :class="{ active: wm.mode === 'layer' }" @click="wm.mode = 'layer'">图层</button>
                  <button :class="{ active: wm.mode === 'raster' }" @click="wm.mode = 'raster'">防删除</button>
                </div>
                <div class="field-hint">{{ wm.mode === 'layer' ? '水印作为图层叠加，文件几乎不变大，文字仍可复制' : '整页栅格化，水印融进像素无法移除；文字不可选、文件变大' }}</div>
              </div>
              <div class="field" v-if="wm.mode === 'raster'">
                <div class="field-label">清晰度</div>
                <div class="segmented">
                  <button v-for="d in [150, 200, 300]" :key="d" :class="{ active: wm.dpi === d }" @click="wm.dpi = d">{{ d }} DPI</button>
                </div>
              </div>
              <div class="field">
                <div class="field-label">页码范围</div>
                <input class="tinput" v-model.trim="wm.range" placeholder="全部页 (如 1-3,5)" spellcheck="false" />
              </div>
              <button class="btn primary wide" @click="applyWatermark">添加水印</button>
            </template>

            <!-- 页面管理 -->
            <template v-else-if="tool === 'pages'">
              <div class="field">
                <div class="field-label">已选 {{ selected.size }} / {{ doc.pageCount }} 页</div>
                <div class="segmented">
                  <button @click="selectAll(true)">全选</button>
                  <button @click="selectAll(false)">清空</button>
                </div>
                <div class="field-hint">点击左侧缩略图勾选页面</div>
              </div>
              <button class="btn primary wide" @click="applyPages('extract')">提取所选 → 新 PDF</button>
              <button class="btn ghost wide" @click="applyPages('delete')">删除所选 → 新 PDF</button>
              <button class="btn ghost wide" @click="applyPages('rotate')">所选旋转 90°</button>
              <div class="field-hint pad-top">所有操作输出新文件，不改动原文档</div>
            </template>

            <!-- 合并 -->
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
                <span class="btn-icon" v-html="ICONS.plus"></span>添加 PDF
              </button>
              <button class="btn primary wide" @click="applyMerge">合并 {{ mergeList.length }} 个文档</button>
              <div class="field-hint pad-top">也可以直接把 PDF 拖进窗口加入列表</div>
            </template>

            <!-- 转图片 -->
            <template v-else-if="tool === 'export'">
              <div class="field">
                <div class="field-label">图片格式</div>
                <div class="segmented">
                  <button :class="{ active: exp.format === 'png' }" @click="exp.format = 'png'">PNG</button>
                  <button :class="{ active: exp.format === 'jpg' }" @click="exp.format = 'jpg'">JPG</button>
                </div>
              </div>
              <div class="field">
                <div class="field-label">清晰度</div>
                <div class="segmented">
                  <button v-for="d in [150, 200, 300]" :key="d" :class="{ active: exp.dpi === d }" @click="exp.dpi = d">{{ d }} DPI</button>
                </div>
              </div>
              <div class="field">
                <div class="field-label">页码范围</div>
                <input class="tinput" v-model.trim="exp.range" placeholder="全部页 (如 1-3,5)" spellcheck="false" />
              </div>
              <button class="btn primary wide" @click="applyExport">导出图片</button>
              <div class="field-hint pad-top">图片保存在原文档旁边，按页码编号</div>
            </template>

            <!-- 加密 -->
            <template v-else-if="tool === 'protect'">
              <div class="field">
                <div class="field-label">打开密码</div>
                <input class="tinput" type="password" v-model="prot.pw" placeholder="设置打开密码" />
              </div>
              <div class="field">
                <div class="field-label">确认密码</div>
                <input class="tinput" type="password" v-model="prot.pw2" placeholder="再输一遍" @keyup.enter="applyProtect" />
              </div>
              <div class="field">
                <div class="field-label">权限限制</div>
                <div class="segmented">
                  <button :class="{ active: prot.noPrint }" @click="prot.noPrint = !prot.noPrint">禁止打印</button>
                  <button :class="{ active: prot.noCopy }" @click="prot.noCopy = !prot.noCopy">禁止复制</button>
                </div>
                <div class="field-hint">AES 加密。密码丢了没有任何后门可以找回，务必记牢</div>
              </div>
              <button class="btn primary wide" @click="applyProtect">加密输出</button>
            </template>

            <!-- 解密 -->
            <template v-else-if="tool === 'unlock'">
              <div class="field" v-if="doc.password">
                <div class="field-label">当前文档已用密码解锁</div>
                <div class="field-hint">输出一份无密码副本，之后任何人都能直接打开</div>
              </div>
              <div class="field" v-else>
                <div class="field-label">当前文档没有打开密码</div>
                <div class="field-hint">无需解密。要处理加密文件，直接打开它并输入密码即可</div>
              </div>
              <button class="btn primary wide" :disabled="!doc.password" @click="applyUnlock">移除密码输出</button>
            </template>

            <!-- 压缩 -->
            <template v-else-if="tool === 'compress'">
              <div class="field">
                <div class="field-label">清晰度</div>
                <div class="segmented">
                  <button v-for="d in [[110, '较小'], [150, '均衡'], [200, '较清晰']]" :key="d[0]" :class="{ active: cmp.dpi === d[0] }" @click="cmp.dpi = d[0]">{{ d[1] }}</button>
                </div>
                <div class="field-hint">整页栅格化重建，适合扫描件；文字型 PDF 压缩后文字不可选</div>
              </div>
              <button class="btn primary wide" @click="applyCompress">开始压缩</button>
            </template>
          </aside>
        </div>
      </template>
    </main>

    <!-- 拖拽遮罩 -->
    <div v-if="dragging" class="drag-overlay">
      <div class="drag-overlay-text">松手，交给轻卷</div>
    </div>

    <!-- 任务进度 -->
    <div v-if="busy.active" class="busy-mask">
      <div class="busy-box">
        <div class="busy-stage">{{ busy.stage }}</div>
        <div class="progress-bar">
          <div class="progress-fill" :style="{ width: busy.total ? (busy.done / busy.total) * 100 + '%' : '30%' }"></div>
        </div>
        <div class="busy-count" v-if="busy.total > 1">{{ busy.done }} / {{ busy.total }} 页</div>
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

/* 侧栏 (轻系列同款) */
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

/* 主区 */
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

/* 顶栏 */
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

/* 工作区 */
.workspace {
  flex: 1;
  display: flex;
  min-height: 0;
}
.viewer {
  flex: 1;
  overflow: auto;
  padding: 22px 0 40px;
}
.pages {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}
.page {
  position: relative;
  background: #fff;
  box-shadow: 0 1px 3px rgba(26, 34, 51, 0.09), 0 6px 22px rgba(26, 34, 51, 0.07);
  border-radius: 3px;
  overflow: hidden;
}
.page canvas {
  width: 100%;
  height: 100%;
  display: block;
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
}

/* 缩略图 */
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

/* 工具面板 */
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

/* 合并列表 */
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

/* 按钮 */
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

/* 遮罩 */
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
</style>
