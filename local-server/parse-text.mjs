/**
 * 本地解析播客链接：只抓用户粘贴的那一页的公开 meta（og:audio 等），
 * 不做登录、不做批量爬取。支持小宇宙单集页、Apple Podcast 中国区，以及直接的音频地址。
 */
import * as cheerio from "cheerio"

const MAX_FETCH_MS = 8000
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

export function isDirectAudioLink(link) {
  try {
    const u = new URL(link)
    if (/\.(mp3|m4a|aac|wav|ogg)(\?|$)/i.test(u.pathname + (u.search || ""))) return true
    if (u.pathname.startsWith("/demo/")) return true
  } catch {
    return false
  }

  const reg = /^http(s)?:\/\/[\w.-]*\w{1,32}\.\w{2,6}\/\S+\.(mp3|m4a)[?=.\w%-]*$/gi
  const matches = link.matchAll(reg)
  for (const match of matches) {
    if (match[0]) return true
  }
  return false
}

export async function parseText(link) {
  if (isDirectAudioLink(link)) {
    return {
      code: "0000",
      data: {
        infoType: "podcast",
        audioUrl: link,
        title: "本地音频",
        description: "通过直接音频链接创建的房间",
        linkUrl: link,
        sourceType: "cdn",
      },
    }
  }

  const html = await fetchLink(link)
  if (!html) return { code: "E4004" }
  return parseHtml(html, link)
}

async function fetchLink(link) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), MAX_FETCH_MS)
  try {
    const res = await fetch(link, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    })
    if (!res.ok) return ""
    const html = await res.text()
    if (!html || typeof html !== "string") return ""
    const lower = html.toLowerCase()
    if (!lower.includes("head") || !lower.includes("meta")) return ""
    return html
  } catch (err) {
    console.log("fetchLink failed:", err?.message || err)
    return ""
  } finally {
    clearTimeout(timer)
  }
}

function parseHtml(html, originLink) {
  const $ = cheerio.load(html)

  let appName = ""
  let sourceType = ""
  let title = ""
  let audioUrl = ""
  let description = ""
  let imageUrl = ""
  let twitterImage = ""
  let linkUrl = ""
  let seriesName = ""
  let seriesUrl = ""

  $("head meta").each((_, el) => {
    const meta = $(el)
    const metaProperty = meta.attr("property")
    const metaName = meta.attr("name")
    const metaContent = meta.attr("content") || ""

    if (metaProperty === "og:title") title = metaContent
    else if (metaProperty === "og:description" || metaProperty === "description" || metaName === "description") {
      if (!description) description = metaContent
    }
    else if (metaProperty === "og:image") imageUrl = metaContent
    else if (metaProperty === "og:audio") audioUrl = metaContent
    else if (metaName === "application-name") appName = metaContent
    else if (metaProperty === "twitter:image") twitterImage = metaContent
    else if (metaProperty === "og:url") linkUrl = metaContent
    else if (metaProperty === "og:site_name" && !appName) appName = metaContent
  })

  if (!audioUrl) {
    audioUrl = getAudioUrl(html)
    if (!audioUrl) return { code: "E4004" }
  }

  if (!imageUrl && twitterImage) imageUrl = twitterImage
  if (!title) title = $("head title").text().trim() || ""

  $("head script").each((_, el) => {
    const spt = $(el)
    const sptName = spt.attr("name")
    if (sptName === "schema:podcast-show") {
      let sptJson = {}
      try { sptJson = JSON.parse(spt.text() || "{}") } catch { /* ignore */ }
      if (sptJson?.url) linkUrl = sptJson.url
      const partOfSeries = sptJson?.partOfSeries || {}
      seriesName = partOfSeries.name || seriesName
      seriesUrl = partOfSeries.url || seriesUrl
      if (sptJson?.description) description = sptJson.description
    } else if (sptName === "schema:podcast-episode") {
      let sptJson = {}
      try { sptJson = JSON.parse(spt.text() || "{}") } catch { /* ignore */ }
      if (sptJson.name) title = sptJson.name
      if (sptJson.description) description = sptJson.description
      if (sptJson.isPartOf) seriesName = sptJson.isPartOf
    }
  })

  if (!linkUrl) linkUrl = originLink

  if (appName === "小宇宙") sourceType = "xiaoyuzhou"
  else if (originLink.includes("podcasts.apple.com")) sourceType = "apple_podcast"
  else if (appName && !seriesName) seriesName = appName

  return {
    code: "0000",
    data: {
      infoType: "podcast",
      title,
      audioUrl,
      description,
      imageUrl,
      linkUrl,
      sourceType,
      seriesName,
      seriesUrl,
    },
  }
}

function getAudioUrl(html) {
  const reg0 = /http(s)?:\/\/[^\s/"']{2,40}\/[^\s"']{2,240}\.(mp3|m4a)\?[^\s/"']{3,240}/g
  let matches = html.matchAll(reg0)
  for (const match0 of matches) return match0[0]

  const reg = /http(s)?:\/\/[^\s/"']{2,40}\/[^\s"']{2,240}\.(mp3|m4a)/g
  matches = html.matchAll(reg)
  for (const match1 of matches) return match1[0]
  return ""
}
