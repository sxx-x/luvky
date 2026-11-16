<script setup lang="ts">
import "shikwasa2/dist/shikwasa.min.css"
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue"
import { useRoomPage } from "../room-page/tools/useRoomPage"
import { extractXiaoyuzhouEpisodeLink } from "./tools/episode-link"
import { sampleCoverEdge } from "./tools/cover-edge"
import { useAddToHomeScreen } from "./tools/useAddToHomeScreen"
import ptApi from "../../utils/pt-api"
import cui from "../../components/custom-ui"

const SAME_URL = "https://luvky.top"
const EMPTY_EDGE = "#f3efe9"
const PLAYING_EDGE = "#161210"

const isWeChat = ptApi.getCharacteristic().isWeChat
const { pageData, playerEl, submitEpisode, onTapSyncGate } = useRoomPage()
const { showInstallPwaBtn, onTapInstall, showIosA2hsHint } = useAddToHomeScreen()

const draft = ref("")
const revealEntry = ref(false)
const linkInput = ref<HTMLInputElement | null>(null)
let lastSubmit = ""
let lastSubmitAt = 0

const hasAudio = computed(() => Boolean(pageData.content?.audioUrl))
const showSyncGate = computed(() => pageData.showSyncGate && hasAudio.value)
const coverUrl = computed(() => pageData.content?.imageUrl || "")
const washStyle = computed(() => {
  const url = coverUrl.value.replace(/[\n\r"\\]/g, "")
  if (!url) return undefined
  return { backgroundImage: `url("${url}")` }
})

function paintEdge(color: string) {
  const root = document.documentElement
  root.style.setProperty("--listen-edge", color)
  root.style.backgroundColor = color
  document.body.style.backgroundColor = color
  document.querySelectorAll('meta[name="theme-color"]').forEach((node) => {
    node.setAttribute("content", color)
  })
}

function onPlayingSurface() {
  return hasAudio.value && !isWeChat && pageData.state !== 15
}

let edgeTicket = 0
function refreshEdge(reset: boolean) {
  const ticket = ++edgeTicket
  if (!onPlayingSurface()) {
    paintEdge(EMPTY_EDGE)
    return
  }
  if (reset) paintEdge(PLAYING_EDGE)
  const url = coverUrl.value.replace(/[\n\r"\\]/g, "")
  const viewport = { width: window.innerWidth, height: window.innerHeight }
  void sampleCoverEdge(url, viewport).then((color) => {
    if (ticket !== edgeTicket || !onPlayingSurface()) return
    paintEdge(color || PLAYING_EDGE)
  })
}

watch(hasAudio, (playing) => {
  if (!playing) revealEntry.value = false
  refreshEdge(true)
}, { immediate: true })

watch(coverUrl, () => {
  if (onPlayingSurface()) refreshEdge(false)
})

watch(() => pageData.state, (_state, prev) => {
  const wasPlaying = hasAudio.value && !isWeChat && prev !== 15
  refreshEdge(onPlayingSurface() && !wasPlaying)
})

let edgeResize = 0
function onViewportResize() {
  window.clearTimeout(edgeResize)
  edgeResize = window.setTimeout(() => {
    if (onPlayingSurface()) refreshEdge(false)
  }, 120)
}

onMounted(() => {
  window.addEventListener("resize", onViewportResize)
  window.visualViewport?.addEventListener("resize", onViewportResize)
})

onUnmounted(() => {
  window.removeEventListener("resize", onViewportResize)
  window.visualViewport?.removeEventListener("resize", onViewportResize)
  window.clearTimeout(edgeResize)
  edgeTicket++
  paintEdge(EMPTY_EDGE)
})

function submitOrWarn(text: string) {
  const link = extractXiaoyuzhouEpisodeLink(text)
  if (!link) {
    if (text.trim()) {
      cui.showModal({
        title: "请粘贴小宇宙单集链接",
        content: "只能粘贴小宇宙单集链接",
        showCancel: false,
      })
    }
    return false
  }
  const now = Date.now()
  if (link === lastSubmit && now - lastSubmitAt < 1200) return true
  lastSubmit = link
  lastSubmitAt = now
  draft.value = ""
  revealEntry.value = false
  void submitEpisode(link)
  return true
}

function onPaste(ev: ClipboardEvent) {
  const text = ev.clipboardData?.getData("text") ?? ""
  if (text.trim()) {
    ev.preventDefault()
    draft.value = ""
    submitOrWarn(text)
    return
  }
  window.setTimeout(() => {
    if (!draft.value.trim()) return
    const value = draft.value
    draft.value = ""
    submitOrWarn(value)
  }, 0)
}

function onEnter() {
  if (!draft.value.trim()) return
  const value = draft.value
  draft.value = ""
  submitOrWarn(value)
}

async function readClipboard(): Promise<string> {
  try {
    if (!navigator.clipboard?.readText) return ""
    return (await navigator.clipboard.readText()) || ""
  } catch {
    return ""
  }
}

async function onTapPaste() {
  const text = await readClipboard()
  if (text.trim() && submitOrWarn(text)) return
  if (!hasAudio.value) {
    linkInput.value?.focus()
    return
  }
  revealEntry.value = true
  await nextTick()
  linkInput.value?.focus()
}

async function onTapShare() {
  const data: ShareData = {
    title: "一起听播客",
    text: "两人打开同一个网址，就是同一场。",
    url: SAME_URL,
  }
  if (typeof navigator.share === "function") {
    try {
      await navigator.share(data)
      return
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return
    }
  }
  const copied = await ptApi.copyToClipboard(SAME_URL)
  await cui.showModal({
    title: copied ? "已复制网址" : "分享同一网址",
    content: SAME_URL,
    showCancel: false,
  })
}
</script>

<template>
  <div v-if="isWeChat" class="gate-screen">
    <p class="gate-title">请用 Safari 打开</p>
  </div>

  <div v-else-if="pageData.state === 15" class="gate-screen">
    <p class="gate-title">{{ pageData.notice || "已经有两个人在一起听了" }}</p>
  </div>

  <div v-else class="listen-page" :class="hasAudio ? 'is-playing' : 'is-empty'">
    <div v-if="hasAudio && washStyle" class="cover-wash" :style="washStyle" aria-hidden="true"></div>
    <div v-if="hasAudio && washStyle" class="cover-dim" aria-hidden="true"></div>

    <div class="listen-column">
      <header v-if="!hasAudio" class="empty-head">
        <h1>请粘贴小宇宙单集链接</h1>
        <p class="empty-sub">两人打开同一个网址，就是同一场。</p>
        <p v-if="showIosA2hsHint" class="a2hs-hint">想放到主屏幕，用 Safari 底部工具栏，<br>再选添加到主屏幕。</p>
      </header>

      <div v-if="!hasAudio" class="cover-slot-wrap">
        <div class="cover-slot" aria-hidden="true"></div>
      </div>

      <div v-show="hasAudio" class="stage">
        <div ref="playerEl" class="player"></div>
      </div>

      <div class="thumb">
        <p v-if="pageData.parsing" class="parsing">正在解析…</p>
        <input
          v-show="!hasAudio || revealEntry"
          id="episode-link"
          ref="linkInput"
          v-model="draft"
          class="link-input"
          type="url"
          inputmode="url"
          enterkeyhint="go"
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          maxlength="1000"
          placeholder="https://www.xiaoyuzhoufm.com/episode/…"
          @paste="onPaste"
          @keydown.enter.prevent="onEnter"
        />
        <button v-if="!hasAudio" type="button" class="btn btn-paste" @click="onTapPaste">粘贴链接</button>
        <button type="button" class="btn btn-share" @click="onTapShare">分享同一网址</button>
        <button v-if="hasAudio" type="button" class="btn btn-swap" @click="onTapPaste">换一集</button>
        <button v-if="showInstallPwaBtn" type="button" class="install-btn" @click="onTapInstall">安装应用</button>
      </div>
    </div>

    <div v-if="showSyncGate" class="sync-gate" @click="onTapSyncGate">
      <div class="sync-gate-card" @click.stop="onTapSyncGate">
        <h2>点击开始同步收听</h2>
        <p>点一下即可对齐进度</p>
        <button type="button" class="sync-gate-btn" @click.stop="onTapSyncGate">开始同步收听</button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.listen-page {
  position: fixed;
  inset: 0;
  z-index: 1;
  overflow: hidden;
  font-family: "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, sans-serif;
  -webkit-font-smoothing: antialiased;
}

.listen-page.is-empty {
  background: #f3efe9;
  color: #2a2724;
  color-scheme: light;
}

.listen-page.is-playing {
  background: #161210;
  color: #f4f0ea;
  color-scheme: dark;
}

.cover-wash,
.cover-dim {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.cover-wash {
  inset: -18%;
  background-position: center;
  background-size: cover;
  filter: blur(46px) saturate(0.68) brightness(0.5);
  transform: scale(1.08);
}

.cover-dim {
  background: linear-gradient(180deg, rgba(20, 18, 16, 0.22) 0%, rgba(14, 11, 10, 0.38) 100%);
}

.listen-column {
  position: relative;
  z-index: 1;
  height: 100%;
  max-width: 430px;
  margin: 0 auto;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  padding: calc(8px + env(safe-area-inset-top)) 20px calc(10px + env(safe-area-inset-bottom));
  overflow-x: hidden;
  overflow-y: auto;
}

.empty-head {
  flex: none;
  text-align: center;
  padding: 18px 8px 0;
}

.empty-head h1 {
  margin: 0 0 12px;
  font-size: 22px;
  line-height: 1.35;
  font-weight: 700;
  letter-spacing: 0;
  color: #2a2724;
}

.empty-sub {
  margin: 0;
  font-size: 16px;
  line-height: 1.5;
  color: #6a6560;
}

.a2hs-hint {
  margin: 14px auto 0;
  max-width: 300px;
  font-size: 12px;
  line-height: 1.55;
  font-weight: 400;
  color: #b0aaa2;
}

.cover-slot-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px 0 10px;
  container-type: size;
}

.cover-slot {
  width: min(318px, 100cqw, 100cqh);
  aspect-ratio: 1;
  border-radius: 16px;
  background: linear-gradient(180deg, #efe8de 0%, #e6d8ca 100%);
  box-shadow: 0 10px 28px rgba(40, 32, 24, 0.06);
  border: 1px solid rgba(40, 32, 24, 0.05);
}

.stage {
  flex: none;
  width: 100%;
  min-height: 0;
}

.player {
  width: 100%;
  position: relative;
}

.thumb {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  margin-top: 2px;
  padding-bottom: 8px;
}

.is-playing .thumb {
  gap: 0;
  margin-top: 2px;
}

.parsing {
  margin: 0;
  text-align: center;
  font-size: 13px;
  line-height: 1.4;
  color: #8a847c;
}

.is-playing .parsing {
  color: rgba(244, 240, 234, 0.66);
  margin-bottom: 6px;
}

.link-input {
  width: 100%;
  box-sizing: border-box;
  min-height: 48px;
  border: 0;
  border-radius: 16px;
  background: rgba(40, 32, 24, 0.05);
  color: #2a2724;
  font-size: 14px;
  line-height: 1.4;
  text-align: center;
  padding: 14px;
  font-family: inherit;
  user-select: text;
  -webkit-user-select: text;
}

.link-input::-webkit-input-placeholder {
  color: #9a948c;
}

.link-input::placeholder {
  color: #9a948c;
}

.link-input:focus {
  outline: none;
  box-shadow: inset 0 0 0 1.5px rgba(28, 25, 22, 0.16);
}

.is-playing .link-input {
  margin-bottom: 8px;
  background: rgba(244, 240, 234, 0.08);
  color: #f4f0ea;
}

.is-playing .link-input::-webkit-input-placeholder,
.is-playing .link-input::placeholder {
  color: rgba(244, 240, 234, 0.45);
}

.btn {
  appearance: none;
  -webkit-appearance: none;
  border: 0;
  width: 100%;
  border-radius: 26px;
  font-family: inherit;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.btn-paste {
  background: #1c1916;
  color: #f4f0ea;
  min-height: 56px;
  font-size: 18px;
  font-weight: 700;
}

.btn-paste:active {
  background: #000;
}

.btn-share {
  background: transparent;
  color: #3a3530;
  border: 1.5px solid rgba(28, 25, 22, 0.28);
  min-height: 52px;
  font-size: 17px;
  font-weight: 600;
}

.btn-share:active {
  background: rgba(28, 25, 22, 0.04);
}

.is-playing .btn-share {
  color: rgba(244, 240, 234, 0.86);
  border-color: rgba(244, 240, 234, 0.3);
  min-height: 48px;
  font-size: 16px;
  font-weight: 500;
}

.is-playing .btn-share:active {
  background: rgba(244, 240, 234, 0.06);
}

.btn-swap {
  min-height: 44px;
  background: transparent;
  color: rgba(244, 240, 234, 0.52);
  font-size: 15px;
  font-weight: 500;
}

.btn-swap:active {
  color: rgba(244, 240, 234, 0.78);
}

.install-btn {
  appearance: none;
  -webkit-appearance: none;
  width: 100%;
  min-height: 44px;
  border: 0;
  background: transparent;
  color: #8a847c;
  font-size: 14px;
  font-family: inherit;
  cursor: pointer;
}

.is-playing .install-btn {
  color: rgba(244, 240, 234, 0.5);
}

.gate-screen {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 24px;
  padding-top: calc(24px + env(safe-area-inset-top));
  padding-bottom: calc(24px + env(safe-area-inset-bottom));
  background: #f3efe9;
  color: #2a2724;
  text-align: center;
  color-scheme: light;
}

.gate-title {
  margin: 0;
  font-size: 28px;
  line-height: 1.35;
  font-weight: 700;
  color: #1c1916;
}

.sync-gate {
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: rgba(12, 10, 9, 0.46);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  padding-top: calc(24px + env(safe-area-inset-top));
  padding-bottom: calc(24px + env(safe-area-inset-bottom));
}

.sync-gate-card {
  width: 100%;
  max-width: 360px;
  background: #f3efe9;
  color: #2a2724;
  border-radius: 24px;
  padding: 32px 24px 28px;
  text-align: center;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.18);
}

.sync-gate-card h2 {
  margin: 0 0 12px;
  font-size: 26px;
  line-height: 1.3;
  color: #1c1916;
}

.sync-gate-card p {
  margin: 0 0 28px;
  font-size: 17px;
  line-height: 1.5;
  color: #6a6560;
}

.sync-gate-btn {
  appearance: none;
  -webkit-appearance: none;
  border: 0;
  width: 100%;
  min-height: 52px;
  border-radius: 26px;
  background: #1c1916;
  color: #f4f0ea;
  font-size: 18px;
  font-weight: 700;
  font-family: inherit;
  cursor: pointer;
}

.sync-gate-btn:active {
  background: #000;
}
</style>

<style lang="scss">
/* The cover wash is clipped to the layout viewport. On iPhone 13+ the
   standalone viewport stops short of the glass by the status-bar inset, and
   iOS paints that band with the root background. --listen-edge is the wash
   color at the seam, so the band continues the cover tint. Empty stays cream. */
html:has(.listen-page.is-empty),
html:has(.gate-screen) {
  background-color: #f3efe9;
}

html:has(.listen-page.is-playing) {
  background-color: var(--listen-edge, #161210);
}

body:has(.listen-page),
body:has(.gate-screen) {
  padding: 0;
  background: #f3efe9;
}

body:has(.listen-page.is-playing) {
  background-color: var(--listen-edge, #161210);
}

.classic-theme:has(.listen-page.is-empty),
.classic-theme.dark-theme:has(.listen-page.is-empty),
.classic-theme:has(.gate-screen) {
  background: #f3efe9;
}

.classic-theme:has(.listen-page.is-playing),
.classic-theme.dark-theme:has(.listen-page.is-playing) {
  background-color: var(--listen-edge, #161210);
}

/* Shikwasa hides .shk-cover under 640px and pins the player to the bottom.
   This screen keeps a large in-page cover instead. */
.listen-page .shk,
.listen-page .shk[data-fixed-type="auto"],
.listen-page .shk[data-fixed-type="fixed"] {
  position: relative !important;
  inset: auto !important;
  top: auto !important;
  right: auto !important;
  bottom: auto !important;
  left: auto !important;
  width: 100%;
  margin: 0;
  --color-primary: #f4f0ea;
  --color-text: #f4f0ea;
  --color-title: #f4f0ea;
  --color-artist: rgba(244, 240, 234, 0.66);
  --color-secondary: rgba(244, 240, 234, 0.66);
  --color-button: #f4f0ea;
  --color-time: rgba(244, 240, 234, 0.6);
  --color-handle: #f4f0ea;
  --color-bar-played: #f4f0ea;
  --color-bar-loaded: rgba(255, 255, 255, 0.16);
  --color-theme: transparent;
  --background-body: transparent;
  --shadow-body: none;
  --shadow-body-mobile: none;
  --shadow-handle: none;
  --shadow-handle-mobile: none;
}

.listen-page .shk-player {
  height: auto;
  margin: 0;
  padding: 0;
  background: transparent;
  box-shadow: none;
  border-radius: 0;
  display: flex;
  flex-direction: column;
}

.listen-page .shk-cover {
  display: block !important;
  order: 1;
  align-self: center;
  width: min(318px, 100%, 46dvh);
  aspect-ratio: 1;
  height: auto;
  margin: 8px auto 0;
  border-radius: 16px;
  overflow: hidden;
  background-color: rgba(244, 240, 234, 0.08);
  background-repeat: no-repeat;
  background-position: center;
  background-size: cover;
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.28), 0 2px 8px rgba(0, 0, 0, 0.16);
  flex: none;
}

.listen-page .shk-img {
  display: none;
}

.listen-page .shk-text {
  order: 2;
  margin: 20px 4px 0;
  width: auto;
  max-width: 100%;
  overflow: hidden;
  text-align: left;
  flex: none;
}

.listen-page .shk-title_wrap {
  overflow: hidden;
  max-width: 100%;
}

.listen-page .shk-title_inner,
.listen-page .shk-title_wrap[data-overflow] .shk-title_inner {
  display: block;
  padding: 0 !important;
  white-space: normal;
  animation: none !important;
}

.listen-page .shk-title_wrap[data-overflow] {
  mask-image: none;
  -webkit-mask-image: none;
}

.listen-page .shk-title,
.listen-page .shk-title_wrap[data-overflow] .shk-title,
.listen-page .shk-title_wrap[data-overflow] .shk-title_inner:after {
  animation: none !important;
  color: #f4f0ea;
  font-size: 20px;
  line-height: 1.3;
  font-weight: 700;
  white-space: normal;
}

.listen-page .shk-title_wrap[data-overflow] .shk-title_inner:after {
  content: none !important;
}

.listen-page .shk-artist_wrap {
  margin-top: 6px;
  font-size: 16px;
  line-height: 1.4;
}

.listen-page .shk-artist {
  display: inline;
  color: rgba(244, 240, 234, 0.66);
  font-size: 16px;
  font-weight: 500;
  white-space: normal;
}

.listen-page .shk-bar_wrap {
  order: 3;
  position: relative !important;
  left: auto !important;
  right: auto !important;
  top: auto !important;
  margin: 18px 0 0;
  padding: 14px 0;
}

.listen-page .shk-bar,
.listen-page .shk-bar_wrap:hover .shk-bar {
  height: 5px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.22);
  transition: none;
}

.listen-page .shk-bar_played {
  background: #f4f0ea;
  border-radius: 3px;
}

.listen-page .shk-bar-handle,
.listen-page .shk-bar_wrap:hover .shk-bar-handle,
.listen-page .shk-bar-handle.focus-visible,
.listen-page .shk-bar_wrap:hover .shk-bar-handle:not(:disabled) {
  display: block !important;
  width: 14px;
  height: 14px;
  right: -7px;
  top: 50%;
  margin: 0;
  border: 0 !important;
  border-radius: 50%;
  background: #f4f0ea;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  transform: translateY(-50%) !important;
  opacity: 1;
}

.listen-page .shk-bar-handle::before {
  content: "";
  position: absolute;
  left: 50%;
  top: 50%;
  width: 44px;
  height: 44px;
  transform: translate(-50%, -50%);
}

.listen-page .shk-display {
  order: 4;
  position: static;
  display: flex;
  align-items: center;
  margin: 0 2px 0;
  min-height: 18px;
}

.listen-page .shk-loader {
  position: static;
  left: auto;
  top: auto;
  margin-right: 8px;
}

.listen-page .shk-time {
  display: flex;
  flex: 1;
  justify-content: space-between;
  align-items: center;
  margin: 0;
  width: auto;
  font-family: Inter, "PingFang SC", -apple-system, sans-serif;
  font-size: 13px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
  line-height: 1;
  color: rgba(244, 240, 234, 0.6);
}

.listen-page .shk-time_now,
.listen-page .shk-time_duration {
  width: auto;
  text-align: inherit;
}

.listen-page .shk-time_duration:before {
  content: none !important;
}

.listen-page .shk-controls {
  order: 5;
  position: relative;
  width: 100%;
  height: 96px;
  margin: 2px 0 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.listen-page .shk-controls_basic {
  width: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 18px;
}

.listen-page .shk-btn_speed {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: auto;
  min-width: 48px;
  height: auto;
  min-height: 44px;
  padding: 4px 2px;
  font-family: Inter, "PingFang SC", sans-serif;
  font-size: 13px;
  font-weight: 650;
  line-height: 1.15;
  color: rgba(244, 240, 234, 0.86);
}

.listen-page .shk-btn_speed::before {
  content: "倍速";
  display: block;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.04em;
  opacity: 0.62;
}

.listen-page .shk-btn_more {
  display: none !important;
}

.listen-page .shk-controls_extra,
.listen-page .shk[data-extra] .shk-controls_extra {
  position: absolute;
  right: 0;
  top: 50%;
  bottom: auto;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: flex-end;
  width: auto !important;
  height: auto !important;
  margin: 0;
  padding: 0;
  overflow: visible;
  background: transparent;
  opacity: 1 !important;
  visibility: visible !important;
}

.listen-page .shk-btn_backward,
.listen-page .shk-btn_forward {
  width: 52px;
  height: 52px;
  padding: 0;
  color: #f4f0ea;
  background: transparent;
}

.listen-page .shk-btn_backward svg,
.listen-page .shk-btn_forward svg {
  width: 36px;
  height: 36px;
}

.listen-page .skip-num {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -46%);
  font-family: Inter, "PingFang SC", sans-serif;
  font-size: 9px;
  font-weight: 650;
  line-height: 1;
  pointer-events: none;
  color: #f4f0ea;
}

.listen-page .shk-btn_toggle {
  width: 86px;
  height: 86px;
  padding: 0;
  border-radius: 50%;
  background: rgba(244, 240, 234, 0.22);
  color: #f4f0ea;
  display: flex;
  align-items: center;
  justify-content: center;
}

.listen-page .shk-btn_toggle svg {
  width: 34px;
  height: 34px;
  position: relative;
  z-index: 1;
}

.listen-page .shk-btn_volume {
  width: 44px;
  height: 44px;
  padding: 0;
  color: rgba(244, 240, 234, 0.78);
}

.listen-page .shk-btn_volume svg {
  width: 22px;
  height: 22px;
}

@media (max-width: 400px) {
  .listen-page .shk-controls_basic {
    gap: 12px;
  }

  .listen-page .shk-btn_toggle {
    width: 84px;
    height: 84px;
  }

  .listen-page .shk-btn_backward,
  .listen-page .shk-btn_forward {
    width: 48px;
    height: 48px;
  }

  .listen-page .shk-btn_backward svg,
  .listen-page .shk-btn_forward svg {
    width: 34px;
    height: 34px;
  }

  .listen-page .shk-btn_speed {
    min-width: 44px;
  }
}
</style>
