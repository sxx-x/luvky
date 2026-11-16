<script setup lang="ts">
import "shikwasa2/dist/shikwasa.min.css"
import { computed, ref } from "vue"
import { useRoomPage } from "../room-page/tools/useRoomPage"
import { extractXiaoyuzhouEpisodeLink } from "./tools/episode-link"
import { useAddToHomeScreen } from "./tools/useAddToHomeScreen"
import ptApi from "../../utils/pt-api"
import cui from "../../components/custom-ui"

const isWeChat = ptApi.getCharacteristic().isWeChat
const { pageData, playerEl, submitEpisode, onTapSyncGate } = useRoomPage()
const { showInstallPwaBtn, onTapInstall, showIosA2hsHint } = useAddToHomeScreen()

const draft = ref("")
let lastSubmit = ""
let lastSubmitAt = 0

const hasAudio = computed(() => Boolean(pageData.content?.audioUrl))
const showSyncGate = computed(() => pageData.showSyncGate && hasAudio.value)

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
    return
  }
  const now = Date.now()
  if (link === lastSubmit && now - lastSubmitAt < 1200) return
  lastSubmit = link
  lastSubmitAt = now
  draft.value = ""
  void submitEpisode(link)
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
</script>

<template>
  <div v-if="isWeChat" class="gate-screen">
    <p class="gate-title">请用 Safari 打开</p>
  </div>

  <div v-else-if="pageData.state === 15" class="gate-screen">
    <p class="gate-title">{{ pageData.notice || "已经有两个人在一起听了" }}</p>
  </div>

  <div v-else class="page listen-page">
    <div class="page-container">
      <h1>请粘贴小宇宙单集链接</h1>
      <input
        id="episode-link"
        v-model="draft"
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
      <p v-if="pageData.parsing" class="parsing">正在解析…</p>

      <div ref="playerEl" class="player" v-show="hasAudio"></div>
    </div>

    <div class="listen-footer">
      <button v-if="showInstallPwaBtn" type="button" class="install-btn" @click="onTapInstall">
        安装应用
      </button>
      <p v-if="showIosA2hsHint" class="a2hs">在 Safari 点「分享」，再选「添加到主屏幕」。</p>
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
  min-height: 100vh;
  min-height: 100dvh;
}

.page-container {
  padding-top: calc(28px + env(safe-area-inset-top));
  align-items: stretch;
  text-align: left;

  h1 {
    margin: 0 0 20px;
    font-size: 22px;
    line-height: 1.4;
    font-weight: 700;
    letter-spacing: 0;
    color: var(--text-color);
    text-align: center;
  }

  input {
    width: 100%;
    box-sizing: border-box;
    min-height: 56px;
    padding: 14px 16px;
    border: 0;
    border-radius: 16px;
    background: var(--card-color);
    color: var(--text-color);
    font-size: 17px;
    line-height: 1.4;
    text-align: center;
  }

  input::-webkit-input-placeholder {
    color: var(--note-color);
  }

  .parsing {
    margin: 14px 0 0;
    text-align: center;
    color: var(--desc-color);
    font-size: 15px;
  }

  .player {
    width: 100%;
    margin-top: 28px;
    position: relative;
    z-index: 1;
  }
}

.listen-footer {
  width: 92%;
  max-width: var(--standard-max-px);
  margin: 8px auto 0;
  padding-bottom: calc(24px + env(safe-area-inset-bottom));
}

.install-btn {
  appearance: none;
  width: 100%;
  min-height: 52px;
  border: 0;
  border-radius: 26px;
  background: var(--other-btn-bg);
  color: var(--other-btn-text);
  font-size: 17px;
  cursor: pointer;
}

.a2hs {
  margin: 14px 0 0;
  text-align: center;
  color: var(--note-color);
  font-size: 14px;
  line-height: 1.5;
}

.gate-screen {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px;
  padding-top: calc(24px + env(safe-area-inset-top));
  padding-bottom: calc(24px + env(safe-area-inset-bottom));
  box-sizing: border-box;
  text-align: center;
}

.gate-title {
  margin: 0;
  font-size: 28px;
  line-height: 1.35;
  font-weight: 700;
  color: var(--text-color);
}

.gate-desc {
  margin: 16px 0 0;
  font-size: 17px;
  line-height: 1.5;
  color: var(--desc-color);
}

.sync-gate {
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: color-mix(in srgb, var(--bg-color) 86%, transparent);
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
  background: var(--card-color);
  border-radius: 24px;
  padding: 32px 24px 28px;
  text-align: center;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.12);
}

.sync-gate-card h2 {
  margin: 0 0 12px;
  font-size: 26px;
  line-height: 1.3;
  color: var(--text-color);
}

.sync-gate-card p {
  margin: 0 0 28px;
  font-size: var(--desc-font);
  line-height: 1.5;
  color: var(--desc-color);
}

.sync-gate-btn {
  appearance: none;
  border: 0;
  width: 100%;
  min-height: 52px;
  border-radius: 26px;
  background: var(--main-btn-bg);
  color: var(--main-btn-text);
  font-size: 18px;
  font-weight: 700;
  cursor: pointer;
}

.sync-gate-btn:active {
  background: var(--hover-btn-bg);
}
</style>

<style>
.shk-cover {
  background-position: center;
}
</style>
