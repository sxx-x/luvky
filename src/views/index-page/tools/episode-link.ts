const HOSTS = new Set(["xiaoyuzhoufm.com", "www.xiaoyuzhoufm.com"])
const EPISODE_ID = /^[0-9a-f]{24}$/i

function withScheme(raw: string): string {
  const text = raw.trim()
  if (/^https?:\/\//i.test(text)) return text
  if (/^(www\.)?xiaoyuzhoufm\.com\/episode\//i.test(text)) {
    return "https://" + text.replace(/^\/\//, "")
  }
  return text
}

function tidy(raw: string): string {
  return raw.trim().replace(/[)\]）】>,，。！？、；;]+$/g, "")
}

function urlsIn(text: string): string[] {
  const found: string[] = []
  const re = /https?:\/\/[^\s<>"'「」]+/gi
  for (const match of text.matchAll(re)) found.push(tidy(match[0]))
  const bare = /(?:^|\s)((?:www\.)?xiaoyuzhoufm\.com\/episode\/[^\s<>"'「」]+)/gi
  for (const match of text.matchAll(bare)) found.push(tidy(match[1]))
  return found
}

/** Canonical https episode URL, or null when it is not a 小宇宙单集. */
export function extractXiaoyuzhouEpisodeLink(text: string): string | null {
  if (!text || !text.trim()) return null
  const seen = new Set<string>()
  for (const raw of [tidy(text), ...urlsIn(text)]) {
    if (!raw || seen.has(raw)) continue
    seen.add(raw)
    const link = canonicalEpisode(raw)
    if (link) return link
  }
  return null
}

function canonicalEpisode(link: string): string | null {
  try {
    const url = new URL(withScheme(link))
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    if (url.username || url.password || url.port) return null
    const host = url.hostname.toLowerCase()
    if (!HOSTS.has(host)) return null
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts.length !== 2 || parts[0].toLowerCase() !== "episode") return null
    if (!EPISODE_ID.test(parts[1])) return null
    return `https://${host}/episode/${parts[1].toLowerCase()}`
  } catch {
    return null
  }
}
