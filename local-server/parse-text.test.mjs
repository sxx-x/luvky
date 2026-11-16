import assert from "node:assert/strict"
import { test } from "node:test"
import { parseText, isXiaoyuzhouEpisodeLink } from "./parse-text.mjs"

const ID = "5e280fb0418a84a0461f7c2e"
const EPISODE_URL = `https://www.xiaoyuzhoufm.com/episode/${ID}`

function page(options = {}) {
  const audio = options.audio === undefined
    ? '<meta property="og:audio" content="https://media.xyzcdn.net/test-episode.m4a">'
    : options.audio
  const name = options.name === undefined
    ? '<meta name="application-name" content="小宇宙">'
    : options.name
  const site = options.site === undefined
    ? '<meta property="og:site_name" content="小宇宙">'
    : options.site
  const url = options.url === undefined
    ? `<meta property="og:url" content="${EPISODE_URL}">`
    : options.url
  const extra = options.extra || ""
  return `<!doctype html><html><head>
<meta property="og:title" content="测试单集">
<meta property="og:description" content="一起听">
<meta property="og:image" content="https://image.xyzcdn.net/cover.jpg">
${audio}
${url}
${site}
${name}
<title>测试单集</title>
<script name="schema:podcast-show" type="application/ld+json">{"url":"${EPISODE_URL}","description":"详细简介","partOfSeries":{"name":"商业就是这样","url":"https://www.xiaoyuzhoufm.com/podcast/5e280fa8418a84a0461f6c2e"}}</script>
${extra}
</head><body></body></html>`
}

function okFetch(html) {
  return async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } })
}

test("only a xiaoyuzhou episode url is recognized", () => {
  assert.equal(isXiaoyuzhouEpisodeLink(EPISODE_URL), true)
  assert.equal(isXiaoyuzhouEpisodeLink(`https://xiaoyuzhoufm.com/episode/${ID}/`), true)
  assert.equal(isXiaoyuzhouEpisodeLink(`https://www.xiaoyuzhoufm.com/episode/${ID}?s=share#t=1`), true)
  assert.equal(isXiaoyuzhouEpisodeLink("https://www.xiaoyuzhoufm.com/podcast/5e280fa8418a84a0461f6c2e"), false)
  assert.equal(isXiaoyuzhouEpisodeLink("https://podcasts.apple.com/cn/podcast/id123?i=456"), false)
  assert.equal(isXiaoyuzhouEpisodeLink("https://media.xyzcdn.net/test-episode.m4a"), false)
  assert.equal(isXiaoyuzhouEpisodeLink("http://127.0.0.1:8787/demo/tone.mp3"), false)
  assert.equal(isXiaoyuzhouEpisodeLink("https://www.xiaoyuzhoufm.com/episode/abc"), false)
  assert.equal(isXiaoyuzhouEpisodeLink(`https://user:pass@www.xiaoyuzhoufm.com/episode/${ID}`), false)
  assert.equal(isXiaoyuzhouEpisodeLink(`https://www.xiaoyuzhoufm.com:8443/episode/${ID}`), false)
  assert.equal(isXiaoyuzhouEpisodeLink(`https://evil.com/episode/${ID}`), false)
  assert.equal(isXiaoyuzhouEpisodeLink(`https://www.xiaoyuzhoufm.com.evil.com/episode/${ID}`), false)
})

test("other audio sources are rejected before any fetch", async () => {
  const links = [
    "https://podcasts.apple.com/cn/podcast/example/id123?i=456",
    "https://media.xyzcdn.net/test-episode.m4a",
    "http://127.0.0.1:8787/demo/tone.mp3",
    "https://www.xiaoyuzhoufm.com/podcast/5e280fa8418a84a0461f6c2e",
    "https://mp.weixin.qq.com/s/abcdef",
    "https://www.xiaoyuzhoufm.com/episode/not-an-id",
  ]
  for (const link of links) {
    const result = await parseText(link, async () => {
      throw new Error("fetch should not run for " + link)
    })
    assert.deepEqual(result, {
      code: "E4000",
      errMsg: "XIAOYUZHOU_EPISODE_ONLY",
      showMsg: "只能粘贴小宇宙单集链接",
    })
  }
})

test("an episode page's public meta becomes a xiaoyuzhou podcast payload", async () => {
  let fetched = ""
  const result = await parseText(`http://XiaoyuzhouFM.com/episode/${ID.toUpperCase()}?s=share`, async (url) => {
    fetched = String(url)
    return new Response(page(), { status: 200 })
  })
  assert.equal(fetched, `https://xiaoyuzhoufm.com/episode/${ID}`)
  assert.equal(result.code, "0000")
  assert.deepEqual(result.data, {
    infoType: "podcast",
    title: "测试单集",
    audioUrl: "https://media.xyzcdn.net/test-episode.m4a",
    description: "详细简介",
    imageUrl: "https://image.xyzcdn.net/cover.jpg",
    linkUrl: EPISODE_URL,
    sourceType: "xiaoyuzhou",
    seriesName: "商业就是这样",
    seriesUrl: "https://www.xiaoyuzhoufm.com/podcast/5e280fa8418a84a0461f6c2e",
  })
})

test("og:audio can fall back to an https media url in the page", async () => {
  const html = page({
    audio: "",
    extra: '<a href="https://media.xyzcdn.net/fallback.m4a?sign=1">audio</a>',
  })
  const result = await parseText(EPISODE_URL, okFetch(html))
  assert.equal(result.code, "0000")
  assert.equal(result.data.audioUrl, "https://media.xyzcdn.net/fallback.m4a?sign=1")
  assert.equal(result.data.sourceType, "xiaoyuzhou")
})

test("a page that is not xiaoyuzhou is not stored even if it has audio", async () => {
  const html = page({
    name: '<meta name="application-name" content="Apple Podcasts">',
    site: '<meta property="og:site_name" content="Apple Podcasts">',
    url: '<meta property="og:url" content="https://podcasts.apple.com/cn/podcast/id1">',
  })
  const result = await parseText(EPISODE_URL, okFetch(html))
  assert.equal(result.errMsg, "PARSE_FAILED")
  assert.equal(result.showMsg, "没有解析到这集的音频")
})

test("insecure or missing audio fails the parse", async () => {
  const httpAudio = page({
    audio: '<meta property="og:audio" content="http://media.xyzcdn.net/test.m4a">',
  })
  const missing = page({ audio: "" })
  assert.equal((await parseText(EPISODE_URL, okFetch(httpAudio))).errMsg, "PARSE_FAILED")
  assert.equal((await parseText(EPISODE_URL, okFetch(missing))).errMsg, "PARSE_FAILED")
  assert.equal((await parseText(EPISODE_URL, async () => new Response("no", { status: 404 }))).errMsg, "PARSE_FAILED")
})

test("redirects may stay on xiaoyuzhou and must not leave it", async () => {
  let calls = 0
  const followed = await parseText(`https://xiaoyuzhoufm.com/episode/${ID}`, async () => {
    calls += 1
    if (calls === 1) {
      return new Response(null, {
        status: 301,
        headers: { location: EPISODE_URL },
      })
    }
    return new Response(page(), { status: 200 })
  })
  assert.equal(calls, 2)
  assert.equal(followed.code, "0000")

  let offsiteCalls = 0
  const blocked = await parseText(EPISODE_URL, async () => {
    offsiteCalls += 1
    return new Response(null, {
      status: 302,
      headers: { location: "https://evil.example/steal.mp3" },
    })
  })
  assert.equal(offsiteCalls, 1)
  assert.equal(blocked.errMsg, "PARSE_FAILED")
})
