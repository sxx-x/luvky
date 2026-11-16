/**
 * 只解析小宇宙单集页（xiaoyuzhoufm.com/episode/{24位id}）。
 * 读取用户粘贴的那一页公开 meta（og:audio 等），不登录、不抓其他站点。
 */
import * as cheerio from "cheerio"

const MAX_FETCH_MS = 8000
const MAX_HTML_CHARS = 2_000_000
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

const EPISODE_ONLY = {
  code: "E4000",
  errMsg: "XIAOYUZHOU_EPISODE_ONLY",
  showMsg: "只能粘贴小宇宙单集链接",
}

const PARSE_FAILED = {
  code: "E4004",
  errMsg: "PARSE_FAILED",
  showMsg: "没有解析到这集的音频",
}

function isXiaoyuzhouHost(hostname) {
  const host = String(hostname || "").toLowerCase()
  return host === "xiaoyuzhoufm.com" || host === "www.xiaoyuzhoufm.com"
}

export function isXiaoyuzhouEpisodeLink(link) {
  return Boolean(canonicalEpisodeUrl(link))
}

export function canonicalEpisodeUrl(link) {
  if (typeof link !== "string") return ""
  let url
  try {
    url = new URL(link.trim())
  } catch {
    return ""
  }
  if (url.username || url.password) return ""
  if (url.protocol !== "https:" && url.protocol !== "http:") return ""
  if (url.port && url.port !== "443" && url.port !== "80") return ""
  if (!isXiaoyuzhouHost(url.hostname)) return ""
  const match = url.pathname.match(/^\/episode\/([a-f0-9]{24})\/?$/i)
  if (!match) return ""
  url.protocol = "https:"
  url.hostname = url.hostname.toLowerCase()
  url.port = ""
  url.pathname = `/episode/${match[1].toLowerCase()}`
  url.search = ""
  url.hash = ""
  return url.toString()
}

export async function parseText(link, fetchImpl = globalThis.fetch) {
  const canonical = canonicalEpisodeUrl(link)
  if (!canonical) return EPISODE_ONLY
  const html = await fetchLink(canonical, fetchImpl)
  if (!html) return PARSE_FAILED
  return parseHtml(html, canonical)
}

async function fetchLink(startUrl, fetchImpl) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), MAX_FETCH_MS)
  try {
    let current = startUrl
    for (let hop = 0; hop < 4; hop++) {
      const res = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        signal: ctrl.signal,
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
      })
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location")
        if (!location) return ""
        let next
        try {
          next = new URL(location, current)
        } catch {
          return ""
        }
        if (next.protocol !== "https:" && next.protocol !== "http:") return ""
        if (!isXiaoyuzhouHost(next.hostname)) return ""
        next.protocol = "https:"
        next.hash = ""
        current = next.toString()
        continue
      }
      if (!res.ok) return ""
      if (res.url) {
        let finalUrl
        try {
          finalUrl = new URL(res.url)
        } catch {
          return ""
        }
        if (!isXiaoyuzhouHost(finalUrl.hostname)) return ""
      }
      const html = await res.text()
      if (!html || html.length > MAX_HTML_CHARS) return ""
      const lower = html.toLowerCase()
      if (!lower.includes("head") || !lower.includes("meta")) return ""
      return html
    }
    return ""
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
  let siteName = ""
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
    } else if (metaProperty === "og:image") imageUrl = metaContent
    else if (metaProperty === "og:audio") audioUrl = metaContent
    else if (metaName === "application-name") appName = metaContent
    else if (metaProperty === "twitter:image") twitterImage = metaContent
    else if (metaProperty === "og:url") linkUrl = metaContent
    else if (metaProperty === "og:site_name") siteName = metaContent
  })

  if (!audioUrl) audioUrl = getAudioUrl(html)
  if (!audioUrl || !audioUrl.startsWith("https://") || audioUrl.length > 2000) return PARSE_FAILED

  const explicitLink = linkUrl
  const markedXiaoyuzhou =
    appName.includes("小宇宙") ||
    siteName.includes("小宇宙") ||
    isXiaoyuzhouEpisodeLink(explicitLink)
  if (!markedXiaoyuzhou) return PARSE_FAILED

  if (!imageUrl && twitterImage) imageUrl = twitterImage
  if (!title) title = $("head title").text().trim() || ""

  $("head script").each((_, el) => {
    const script = $(el)
    if (script.attr("name") !== "schema:podcast-show") return
    let data = {}
    try {
      data = JSON.parse(script.text() || "{}")
    } catch {
      return
    }
    if (data?.url) linkUrl = data.url
    const partOfSeries = data?.partOfSeries || {}
    seriesName = partOfSeries.name || seriesName
    seriesUrl = partOfSeries.url || seriesUrl
    if (data?.description) description = data.description
  })

  if (!isXiaoyuzhouEpisodeLink(linkUrl)) linkUrl = originLink

  return {
    code: "0000",
    data: {
      infoType: "podcast",
      title: title.trim(),
      audioUrl,
      description: description.trim(),
      imageUrl: imageUrl.trim(),
      linkUrl: canonicalEpisodeUrl(linkUrl) || originLink,
      sourceType: "xiaoyuzhou",
      seriesName: seriesName.trim(),
      seriesUrl: seriesUrl.trim(),
    },
  }
}

function getAudioUrl(html) {
  const withQuery = /https:\/\/[^\s/"']{2,80}\/[^\s"']{2,300}\.(?:mp3|m4a)\?[^\s"']{1,300}/i
  const queryMatch = withQuery.exec(html)
  if (queryMatch) return queryMatch[0]
  const plain = /https:\/\/[^\s/"']{2,80}\/[^\s"']{2,300}\.(?:mp3|m4a)/i
  const plainMatch = plain.exec(html)
  return plainMatch ? plainMatch[0] : ""
}
