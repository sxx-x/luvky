/**
 * Color of the cover wash where it meets the bottom of the layout viewport.
 *
 * On iPhone 13 and newer, a standalone page with
 * apple-mobile-web-app-status-bar-style=black-translucent is laid out in a
 * viewport shorter than the screen by the status-bar inset (47px on iPhone 13,
 * ~59–62px with a Dynamic Island). That band sits outside the layout viewport,
 * so the cover layers cannot paint into it. iOS fills it with the root
 * background / theme-color. Matching that solid color to the wash at the seam
 * continues the cover tint to the physical bottom.
 *
 * Geometry follows .cover-wash: inset -18%, scale 1.08 about the center,
 * blur(46px) saturate(0.68) brightness(0.5), then the bottom stop of .cover-dim.
 */

const OUTSET = 0.18
const SCALE = 1.08
const BLUR_PX = 46
const SATURATE = 0.68
const BRIGHTNESS = 0.5
const DIM = { r: 14, g: 11, b: 10, a: 0.38 }

/** Fraction down .cover-wash of the pixel that lands on the viewport bottom edge. */
export const COVER_EDGE_FRACTION = (0.5 * (1 + 1 / SCALE) + OUTSET) / (1 + OUTSET * 2)

export function applyWashTone(r: number, g: number, b: number): string {
  const s = SATURATE
  const rs = r * (0.213 + 0.787 * s) + g * (0.715 - 0.715 * s) + b * (0.072 - 0.072 * s)
  const gs = r * (0.213 - 0.213 * s) + g * (0.715 + 0.285 * s) + b * (0.072 - 0.072 * s)
  const bs = r * (0.213 - 0.213 * s) + g * (0.715 - 0.715 * s) + b * (0.072 + 0.928 * s)
  const br = rs * BRIGHTNESS
  const bg = gs * BRIGHTNESS
  const bb = bs * BRIGHTNESS
  const a = DIM.a
  return hex(
    br * (1 - a) + DIM.r * a,
    bg * (1 - a) + DIM.g * a,
    bb * (1 - a) + DIM.b * a,
  )
}

function hex(r: number, g: number, b: number): string {
  const ch = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")
  return `#${ch(r)}${ch(g)}${ch(b)}`
}

function canSample(url: string): boolean {
  if (url.startsWith("data:image/")) return true
  try {
    return new URL(url).protocol === "https:"
  } catch {
    return false
  }
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = "anonymous"
    img.referrerPolicy = "no-referrer"
    img.onload = () => resolve(img.naturalWidth > 0 ? img : null)
    img.onerror = () => resolve(null)
    img.src = url
  })
}

function coverRect(imgW: number, imgH: number, boxW: number, boxH: number) {
  const scale = Math.max(boxW / imgW, boxH / imgH)
  const dw = imgW * scale
  const dh = imgH * scale
  return { dx: (boxW - dw) / 2, dy: (boxH - dh) / 2, dw, dh }
}

function gaussianBlur(src: Uint8ClampedArray, w: number, h: number, sigma: number): Uint8ClampedArray {
  const radius = Math.min(48, Math.ceil(sigma * 3))
  const kernel = new Float32Array(radius * 2 + 1)
  const denom = 2 * sigma * sigma
  let sum = 0
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / denom)
    kernel[i + radius] = v
    sum += v
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum

  const tmp = new Float32Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0
      for (let k = -radius; k <= radius; k++) {
        const xx = Math.min(w - 1, Math.max(0, x + k))
        const i = (y * w + xx) * 4
        const kv = kernel[k + radius]
        r += src[i] * kv
        g += src[i + 1] * kv
        b += src[i + 2] * kv
      }
      const o = (y * w + x) * 3
      tmp[o] = r
      tmp[o + 1] = g
      tmp[o + 2] = b
    }
  }

  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.min(h - 1, Math.max(0, y + k))
        const o = (yy * w + x) * 3
        const kv = kernel[k + radius]
        r += tmp[o] * kv
        g += tmp[o + 1] * kv
        b += tmp[o + 2] * kv
      }
      const i = (y * w + x) * 4
      out[i] = r
      out[i + 1] = g
      out[i + 2] = b
      out[i + 3] = 255
    }
  }
  return out
}

export async function sampleCoverEdge(
  url: string,
  viewport: { width: number; height: number },
): Promise<string | null> {
  if (!canSample(url)) return null
  const vw = viewport.width
  const vh = viewport.height
  if (!(vw >= 32) || !(vh >= 32)) return null
  const img = await loadImage(url)
  if (!img) return null

  const elemW = vw * (1 + OUTSET * 2)
  const elemH = vh * (1 + OUTSET * 2)
  // Keep the blur kernel near 10px so a phone can run this once per cover.
  const sigmaTarget = 10
  const down = sigmaTarget / BLUR_PX
  const cw = Math.max(16, Math.round(elemW * down))
  const ch = Math.max(16, Math.round(elemH * down))
  const canvas = document.createElement("canvas")
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  if (!ctx) return null
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = "high"
  const rect = coverRect(img.naturalWidth, img.naturalHeight, cw, ch)
  ctx.drawImage(img, rect.dx, rect.dy, rect.dw, rect.dh)
  const sigma = BLUR_PX * (ch / elemH)
  const blurred = gaussianBlur(ctx.getImageData(0, 0, cw, ch).data, cw, ch, sigma)
  const x = Math.min(cw - 1, Math.max(0, Math.round(0.5 * (cw - 1))))
  const y = Math.min(ch - 1, Math.max(0, Math.round(COVER_EDGE_FRACTION * (ch - 1))))
  const i = (y * cw + x) * 4
  return applyWashTone(blurred[i], blurred[i + 1], blurred[i + 2])
}
