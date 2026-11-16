/**
 * Dress the Shikwasa DOM for the in-page cover layout.
 * Skip intervals here are the on-screen controls only.
 * Lock-screen artwork and Media Session handlers stay where they are.
 */

/* Ring and arrow arc are both circles centered at (18, 18). The arc used to
   sit on a center near (16.47, 18.20) / its mirror, which made the glyph crooked.
   Endpoints and the arrowhead are that same shape, translated onto the ring. */
const BACK_SVG = `<svg aria-hidden="true" viewBox="0 0 36 36" fill="none">
  <circle cx="18" cy="18" r="15.25" stroke="currentColor" stroke-width="1.6"/>
  <path d="M17.729 8.404 A9.6 9.6 0 1 0 26.729 14.004" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  <path d="M18.129 8.004 L14.929 10.604 L19.129 12.004" fill="currentColor"/>
</svg>`

const FWD_SVG = `<svg aria-hidden="true" viewBox="0 0 36 36" fill="none">
  <circle cx="18" cy="18" r="15.25" stroke="currentColor" stroke-width="1.6"/>
  <path d="M18.271 8.404 A9.6 9.6 0 1 1 9.271 14.004" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  <path d="M17.871 8.004 L21.071 10.604 L16.871 12.004" fill="currentColor"/>
</svg>`

const PLAY_SVG = `<svg class="shk-btn_play" aria-hidden="true" viewBox="0 0 28 28">
  <path fill="currentColor" d="M9.2 5.4c-.9-.5-2 .1-2 1.1v15c0 1 1.1 1.6 2 1.1l13-7.5c.9-.5.9-1.7 0-2.2L9.2 5.4z"/>
</svg>`

const PAUSE_SVG = `<svg class="shk-btn_pause" aria-hidden="true" viewBox="0 0 28 28">
  <rect x="6" y="4" width="5.2" height="20" rx="1.4" fill="currentColor"/>
  <rect x="16.8" y="4" width="5.2" height="20" rx="1.4" fill="currentColor"/>
</svg>`

function formatRemain(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const pad = (n: number) => String(n).padStart(2, "0")
  if (h > 0) return `${h}:${pad(m)}:${pad(ss)}`
  return `${m}:${pad(ss)}`
}

function seekBy(player: any, delta: number) {
  const audio = player?.audio as HTMLAudioElement | undefined
  const current = Number(audio?.currentTime ?? player?.currentTime ?? 0)
  const duration = Number(audio?.duration || player?.duration || 0)
  let next = (Number.isFinite(current) ? current : 0) + delta
  if (next < 0) next = 0
  if (duration > 0 && Number.isFinite(duration) && next > duration) next = duration
  if (typeof player?.seek === "function") player.seek(next)
}

function bindSkip(player: any, button: Element | null, delta: number) {
  if (!button) return
  button.addEventListener("click", (ev) => {
    ev.preventDefault()
    ev.stopImmediatePropagation()
    seekBy(player, delta)
  }, true)
}

function paintRemaining(audio: HTMLAudioElement, root: HTMLElement) {
  const dur = Number(audio.duration)
  const now = Number(audio.currentTime)
  if (!Number.isFinite(dur) || dur <= 0 || !Number.isFinite(now)) return
  const el = root.querySelector(".shk-time_duration")
  if (!el) return
  el.textContent = `-${formatRemain(Math.max(0, dur - now))}`
}

function labelSpeed(button: Element | null) {
  if (!button) return
  const rate = (button.textContent || "1.0x").trim()
  button.setAttribute("aria-label", `倍速 ${rate}`)
  button.setAttribute("title", "倍速")
}

export function presentPlayer(player: any) {
  const root = player?.el as HTMLElement | undefined
  if (!root || root.dataset.immersive === "1") return
  root.dataset.immersive = "1"

  const playerBox = root.querySelector(".shk-player")
  const cover = root.querySelector(".shk-cover")
  const text = root.querySelector(".shk-text")
  const titleWrap = root.querySelector(".shk-title_wrap")
  const artistWrap = root.querySelector(".shk-artist_wrap")
  const bar = root.querySelector(".shk-bar_wrap")
  const display = root.querySelector(".shk-display")
  const controls = root.querySelector(".shk-controls")
  if (playerBox && cover && text && bar && display && controls) {
    if (titleWrap && artistWrap) text.append(titleWrap, artistWrap)
    playerBox.append(cover, text, bar, display, controls)
  }
  root.querySelectorAll(".shk-body, .shk-main").forEach((el) => {
    if (!el.childElementCount) el.remove()
  })

  const back = root.querySelector(".shk-btn_backward")
  const fwd = root.querySelector(".shk-btn_forward")
  const play = root.querySelector("svg.shk-btn_play")
  const pause = root.querySelector("svg.shk-btn_pause")
  if (back) {
    back.setAttribute("aria-label", "后退 15 秒")
    back.setAttribute("title", "后退 15 秒")
    const svg = back.querySelector("svg")
    if (svg) svg.outerHTML = BACK_SVG
    if (!back.querySelector(".skip-num")) {
      const badge = document.createElement("span")
      badge.className = "skip-num"
      badge.textContent = "15"
      badge.setAttribute("aria-hidden", "true")
      back.append(badge)
    }
  }
  if (fwd) {
    fwd.setAttribute("aria-label", "前进 30 秒")
    fwd.setAttribute("title", "前进 30 秒")
    const svg = fwd.querySelector("svg")
    if (svg) svg.outerHTML = FWD_SVG
    if (!fwd.querySelector(".skip-num")) {
      const badge = document.createElement("span")
      badge.className = "skip-num"
      badge.textContent = "30"
      badge.setAttribute("aria-hidden", "true")
      fwd.append(badge)
    }
  }
  if (play) play.outerHTML = PLAY_SVG
  if (pause) pause.outerHTML = PAUSE_SVG

  bindSkip(player, back, -15)
  bindSkip(player, fwd, 30)

  const speed = root.querySelector(".shk-btn_speed")
  labelSpeed(speed)
  speed?.addEventListener("click", () => {
    requestAnimationFrame(() => labelSpeed(speed))
  })

  const mute = root.querySelector(".shk-btn_volume")
  mute?.setAttribute("aria-label", "音量")
  mute?.setAttribute("title", "音量")

  const title = root.querySelector(".shk-title")?.textContent?.trim()
  if (cover) {
    cover.setAttribute("role", "img")
    cover.setAttribute("aria-label", title || "封面")
  }

  const audio = player.audio as HTMLAudioElement | undefined
  if (!audio) return
  const paint = () => paintRemaining(audio, root)
  for (const ev of ["timeupdate", "durationchange", "seeked", "loadedmetadata", "pause", "playing"] as const) {
    audio.addEventListener(ev, () => {
      paint()
      requestAnimationFrame(paint)
    })
  }
}
