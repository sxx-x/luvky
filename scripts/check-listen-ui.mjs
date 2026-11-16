import { extractXiaoyuzhouEpisodeLink } from "../src/views/index-page/tools/episode-link.ts"
import { isSessionFull, SESSION_FULL_TEXT } from "../src/views/room-page/tools/session-contract.ts"

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL", msg)
    process.exitCode = 1
  }
}

const id = "5e280fb0418a84a0461f7c2e"
const episode = `https://www.xiaoyuzhoufm.com/episode/${id}`
assert(extractXiaoyuzhouEpisodeLink(episode) === episode, "plain episode link")
assert(extractXiaoyuzhouEpisodeLink(`来听 ${episode}?s=1#t`) === episode, "query and hash are stripped")
assert(extractXiaoyuzhouEpisodeLink(`http://xiaoyuzhoufm.com/episode/${id}/`) === `https://xiaoyuzhoufm.com/episode/${id}`, "trailing slash and http")
assert(extractXiaoyuzhouEpisodeLink("https://podcasts.apple.com/cn/podcast/id1") === null, "apple podcast is ignored")
assert(extractXiaoyuzhouEpisodeLink("https://www.xiaoyuzhoufm.com/podcast/" + id) === null, "show page is ignored")
assert(extractXiaoyuzhouEpisodeLink("https://www.xiaoyuzhoufm.com/episode/abc") === null, "short id is ignored")
assert(extractXiaoyuzhouEpisodeLink("https://evilxiaoyuzhoufm.com/episode/" + id) === null, "lookalike host is ignored")
assert(isSessionFull({ code: "R0001", errMsg: "SESSION_FULL" }), "third person is full")
assert(SESSION_FULL_TEXT === "已经有两个人在一起听了", "full-room copy")

if (process.exitCode) process.exit(process.exitCode)
console.log("listen-ui checks ok")
