/**
 * 两个浏览器上下文进入同一房间，验证播放状态能同步。
 * 需要本机已启动 local-server 和 Vite（默认 http://127.0.0.1:5173）。
 */
import puppeteer from "puppeteer-core"

const FRONT = process.env.PT_FRONT_URL || "http://127.0.0.1:5173"
const API = process.env.PT_SMOKE_URL || "http://127.0.0.1:8787"
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome-stable"

async function api(path, body) {
  const res = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return res.json()
}

function common(id) {
  return {
    "x-pt-version": "0.10.4-local",
    "x-pt-client": "web",
    "x-pt-stamp": Date.now(),
    "x-pt-language": "zh-CN",
    "x-pt-local-id": id,
  }
}

async function seedUser(page, nonce, nickName) {
  await page.goto(FRONT + "/", { waitUntil: "domcontentloaded" })
  await page.evaluate((nonce, nickName) => {
    const val = JSON.stringify({ data: { nonce, nickName }, stamp: Date.now() })
    localStorage.setItem("pd_user_data", val)
  }, nonce, nickName)
}

async function enterRoom(page, roomId) {
  await page.goto(FRONT + "/room/" + roomId, { waitUntil: "domcontentloaded", timeout: 20000 })
  // 等待房间界面或同步遮罩
  await page.waitForFunction(() => {
    const gate = document.querySelector(".sync-gate-btn")
    const player = document.querySelector(".rp-player")
    const err = document.querySelector(".pf-no-data-box h1")
    return Boolean(gate || (player && player.childElementCount > 0) || err)
  }, { timeout: 20000 })
  const err = await page.$eval(".pf-no-data-box h1", (el) => el?.textContent || "").catch(() => "")
  if (err && err.trim()) throw new Error("room error: " + err)
  const gate = await page.$(".sync-gate-btn")
  if (gate) {
    await gate.click()
    await page.waitForTimeout?.(400)
    await new Promise((r) => setTimeout(r, 400))
  }
}

async function getPlayback(page) {
  return page.evaluate(() => {
    const audio = document.querySelector("audio")
    const btn = document.querySelector(".shk-btn_toggle, .shk-play, button.shk-btn")
    return {
      hasAudio: !!audio,
      paused: audio ? audio.paused : null,
      currentTime: audio ? audio.currentTime : null,
      rate: audio ? audio.playbackRate : null,
      src: audio ? audio.currentSrc || audio.src : null,
    }
  })
}

async function clickPlay(page) {
  // shikwasa 播放按钮
  const clicked = await page.evaluate(() => {
    const selectors = [".shk-btn_toggle", ".shk-play", ".shk-control .shk-btn", "button.shk-btn"]
    for (const s of selectors) {
      const el = document.querySelector(s)
      if (el) { el.click(); return s }
    }
    const audio = document.querySelector("audio")
    if (audio) { audio.play(); return "audio.play" }
    return ""
  })
  if (!clicked) throw new Error("play button not found")
  return clicked
}

async function main() {
  const parse = await api("/parse-text", { ...common("owner-browser"), link: API + "/demo/tone.mp3" })
  if (parse.code !== "0000") throw new Error("parse failed " + JSON.stringify(parse))
  // 让浏览器能拉到音频：用前端同源的 /demo/tone.mp3
  parse.data.audioUrl = FRONT + "/demo/tone.mp3"
  const created = await api("/room-operate", {
    ...common("owner-browser"),
    operateType: "CREATE",
    roomData: parse.data,
    nickName: "房主",
  })
  if (created.code !== "0000") throw new Error("create failed")
  const roomId = created.data.roomId
  await api("/room-operate", { ...common("owner-browser"), operateType: "ENTER", roomId, nickName: "房主" })

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream",
    ],
  })
  try {
    const ctxA = await browser.createBrowserContext()
    const ctxB = await browser.createBrowserContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    pageA.setDefaultTimeout(20000)
    pageB.setDefaultTimeout(20000)

    await seedUser(pageA, "owner-browser", "房主")
    await seedUser(pageB, "guest-browser", "听众")
    await enterRoom(pageA, roomId)
    await enterRoom(pageB, roomId)

    const beforeB = await getPlayback(pageB)
    await clickPlay(pageA)
    // 等同步
    const started = Date.now()
    let afterA, afterB
    while (Date.now() - started < 8000) {
      afterA = await getPlayback(pageA)
      afterB = await getPlayback(pageB)
      if (afterA.paused === false && afterB.paused === false) break
      await new Promise((r) => setTimeout(r, 300))
    }
    if (afterA.paused !== false) throw new Error("owner did not start playing " + JSON.stringify(afterA))
    if (afterB.paused !== false) {
      throw new Error("guest did not follow play " + JSON.stringify({ beforeB, afterA, afterB }))
    }
    console.log("BROWSER SMOKE OK roomId=" + roomId)
    console.log("owner", afterA)
    console.log("guest", afterB)
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error("BROWSER SMOKE FAIL", err)
  process.exit(1)
})
