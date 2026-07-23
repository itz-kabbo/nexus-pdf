export const ZOOM_MIN = 0.0833
export const ZOOM_MAX = 6.4

export const ZOOM_STEPS = [
  0.0833, 0.125, 0.18, 0.25, 0.333, 0.5, 0.667, 0.75, 1,
  1.25, 1.5, 2, 3, 4, 6.4,
]

export function clampZoom(value) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value))
}

export function nextZoomStep(current, direction) {
  const epsilon = 0.001
  if (direction > 0) {
    return ZOOM_STEPS.find((step) => step > current + epsilon) ?? ZOOM_MAX
  }
  return [...ZOOM_STEPS].reverse().find((step) => step < current - epsilon) ?? ZOOM_MIN
}

// Sumatra 的显示模式由「列布局」和「是否连续」两部分组成。
// book 模式的第一页是封面，之后从第 2 页开始两两成组。
export function buildPageRows(pageCount, layout = 'single') {
  if (layout === 'single') {
    return Array.from({ length: pageCount }, (_, index) => [index])
  }

  const rows = []
  let index = 0
  if (layout === 'book' && pageCount > 0) {
    rows.push([0])
    index = 1
  }
  while (index < pageCount) {
    rows.push(index + 1 < pageCount ? [index, index + 1] : [index])
    index += 2
  }
  return rows
}

export function rowForPage(rows, pageIndex) {
  return rows.find((row) => row.includes(pageIndex)) ?? rows[0] ?? []
}

export function rowForPageIndex(pageCount, layout, pageIndex) {
  if (pageCount <= 0) return []
  const index = Math.min(pageCount - 1, Math.max(0, pageIndex))
  if (layout === 'single') return [index]
  if (layout === 'book') {
    if (index === 0) return [0]
    const start = 1 + Math.floor((index - 1) / 2) * 2
    return start + 1 < pageCount ? [start, start + 1] : [start]
  }
  const start = Math.floor(index / 2) * 2
  return start + 1 < pageCount ? [start, start + 1] : [start]
}

export function rotatedSize(size, rotation) {
  const normalized = ((rotation % 360) + 360) % 360
  return normalized % 180 === 0
    ? { w: size.w, h: size.h }
    : { w: size.h, h: size.w }
}

/**
 * 把 Sumatra 的虚拟缩放模式换算成当前页组的实际比例。
 * contentBoxes 是页面内容在可见页面中的归一化包围盒，用于「适合内容」。
 */
export function scaleForPage({
  sizes,
  pageIndex,
  layout,
  zoomMode,
  customZoom,
  rotation,
  viewportWidth,
  viewportHeight,
  contentBoxes = {},
  pageGap = 14,
  horizontalPadding = 48,
  verticalPadding = 34,
}) {
  if (zoomMode === 'custom' || !sizes?.length) return clampZoom(customZoom)

  const row = rowForPageIndex(sizes.length, layout, pageIndex)
  const visibleWidth = Math.max(80, viewportWidth - horizontalPadding)
  const visibleHeight = Math.max(80, viewportHeight - verticalPadding)

  let rowWidth = 0
  let rowHeight = 0
  for (const index of row) {
    const size = rotatedSize(sizes[index], rotation)
    const content = zoomMode === 'fit-content'
      ? (contentBoxes instanceof Map ? contentBoxes.get(index) : contentBoxes[index])
      : null
    const width = size.w * (content?.width ?? (zoomMode === 'fit-content' ? 0.94 : 1))
    const height = size.h * (content?.height ?? (zoomMode === 'fit-content' ? 0.94 : 1))
    rowWidth += width
    rowHeight = Math.max(rowHeight, height)
  }
  rowWidth += Math.max(0, row.length - 1) * pageGap

  const fitWidth = visibleWidth / Math.max(1, rowWidth)
  if (zoomMode === 'fit-width') return clampZoom(fitWidth)
  return clampZoom(Math.min(fitWidth, visibleHeight / Math.max(1, rowHeight)))
}

export function buildTextMap(items) {
  let text = ''
  const segments = []
  let textItemIndex = 0
  for (const item of items) {
    if (typeof item?.str !== 'string') continue
    const start = text.length
    text += item.str
    segments.push({ start, end: text.length, itemIndex: textItemIndex++ })
    if (item.hasEOL) text += '\n'
  }
  return { text, segments }
}

export function findMatchesInText(text, query) {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return []
  const haystack = text.toLocaleLowerCase()
  const matches = []
  let from = 0
  while (from <= haystack.length - needle.length) {
    const start = haystack.indexOf(needle, from)
    if (start < 0) break
    matches.push({ start, end: start + needle.length })
    from = start + Math.max(1, needle.length)
  }
  return matches
}

export function segmentsForMatch(segments, match) {
  return segments
    .filter((segment) => segment.end > match.start && segment.start < match.end)
    .map((segment) => ({
      itemIndex: segment.itemIndex,
      start: Math.max(0, match.start - segment.start),
      end: Math.min(segment.end, match.end) - segment.start,
    }))
    .filter((segment) => segment.end > segment.start)
}
