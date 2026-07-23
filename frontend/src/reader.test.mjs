import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPageRows,
  buildTextMap,
  findMatchesInText,
  nextZoomStep,
  rowForPageIndex,
  scaleForPage,
  segmentsForMatch,
} from './reader.js'

test('builds Sumatra-style single, facing and book rows', () => {
  assert.deepEqual(buildPageRows(5, 'single'), [[0], [1], [2], [3], [4]])
  assert.deepEqual(buildPageRows(5, 'facing'), [[0, 1], [2, 3], [4]])
  assert.deepEqual(buildPageRows(5, 'book'), [[0], [1, 2], [3, 4]])
  assert.deepEqual(rowForPageIndex(5, 'book', 2), [1, 2])
  assert.deepEqual(rowForPageIndex(5, 'facing', 4), [4])
})

test('maps search matches across PDF text items', () => {
  const map = buildTextMap([
    { type: 'beginMarkedContent' },
    { str: 'Light', hasEOL: false },
    { str: 'Scroll', hasEOL: true },
    { type: 'endMarkedContent' },
    { str: 'PDF', hasEOL: false },
  ])
  const [match] = findMatchesInText(map.text, 'lightsCROLL')
  assert.deepEqual(segmentsForMatch(map.segments, match), [
    { itemIndex: 0, start: 0, end: 5 },
    { itemIndex: 1, start: 0, end: 6 },
  ])
})

test('uses row width for facing fit-width mode', () => {
  const scale = scaleForPage({
    sizes: [{ w: 600, h: 800 }, { w: 600, h: 800 }],
    pageIndex: 0,
    layout: 'facing',
    zoomMode: 'fit-width',
    customZoom: 1,
    rotation: 0,
    viewportWidth: 1262,
    viewportHeight: 900,
    horizontalPadding: 48,
    pageGap: 14,
  })
  assert.equal(scale, 1)
})

test('moves through Sumatra zoom steps', () => {
  assert.equal(nextZoomStep(1, 1), 1.25)
  assert.equal(nextZoomStep(1, -1), 0.75)
})
