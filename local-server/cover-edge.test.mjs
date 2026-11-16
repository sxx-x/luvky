import assert from "node:assert/strict"
import test from "node:test"
import { COVER_EDGE_FRACTION, applyWashTone } from "../src/views/index-page/tools/cover-edge.ts"

test("cover wash seam sits on the scaled outset element", () => {
  // inset -18% keeps the element centered; scale 1.08 is about that center.
  // The viewport bottom maps to ~84% down the wash, not the image edge.
  assert.ok(Math.abs(COVER_EDGE_FRACTION - 0.8404139434) < 1e-9)
})

test("wash tone is saturate, then brightness, then the dim overlay", () => {
  assert.equal(applyWashTone(255, 255, 255), "#545353")
  assert.equal(applyWashTone(0, 0, 0), "#050404")
})
