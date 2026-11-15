import { ref, onMounted } from "vue";
import time from "../../../utils/time";
import cui from "../../../components/custom-ui";

let deferredPrompt: Event | null
const showInstallPwaBtn = ref(false)
const showIosA2hsHint = ref(false)

function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false
  const ua = navigator.userAgent || ""
  const iOS = /iPad|iPhone|iPod/.test(ua)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  if (!iOS) return false
  // Exclude Chromium / Firefox / Edge iOS shells; keep Safari (and the in-app WebKit view).
  return /WebKit/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|YaBrowser/i.test(ua)
}

function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false
  const nav = navigator as Navigator & { standalone?: boolean }
  if (nav.standalone === true) return true
  return window.matchMedia("(display-mode: standalone)").matches
    || window.matchMedia("(display-mode: fullscreen)").matches
}

async function onTapInstall() {
  if(!deferredPrompt) {
    showInstallPwaBtn.value = false
    return
  }

  //@ts-ignore
  deferredPrompt.prompt()

  let installStamp = time.getTime()
  
  //@ts-ignore
  const userChoice = await deferredPrompt.userChoice
  if(userChoice?.outcome === "accepted") {
    console.log('User accepted the A2HS prompt')
    deferredPrompt = null
    showInstallPwaBtn.value = false
    return
  }

  console.log('User dismissed the A2HS prompt')
  console.log(userChoice)
  
  if(time.isWithinMillis(installStamp, 60)) {
    await cui.showModal({
      title: "安装失败",
      content: "你的浏览器似乎不支持安装 PWA 应用",
      showCancel: false,
    })
    deferredPrompt = null
    showInstallPwaBtn.value = false
  }
}

async function startToListening() {

  // console.log("start to listen beforeinstallprompt.............")
  // console.log(" ")

  if (isIosSafari() && !isStandaloneDisplay()) {
    showIosA2hsHint.value = true
  }

  window.addEventListener("beforeinstallprompt", (e: Event) => {
    console.log("beforeinstallprompt.........")
    console.log(e)
    console.log(" ")
    e.preventDefault()

    deferredPrompt = e
    showInstallPwaBtn.value = true
    showIosA2hsHint.value = false
  })

  window.addEventListener("appinstalled", () => {
    console.log("PWA was installed !!!!!!!!")
    console.log(" ")

    deferredPrompt = null
    showInstallPwaBtn.value = false
    showIosA2hsHint.value = false
  })
}


export function useAddToHomeScreen() {
  
  onMounted(() => {
    startToListening()
  })

  return { showInstallPwaBtn, onTapInstall, showIosA2hsHint }
}
