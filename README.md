# Trawl

**Deep research for any AI IDE, with sources the server checks.** Trawl is an MCP server: plug it into Claude Code, Cursor, VS Code (Copilot), Windsurf, Codex, Gemini CLI or Claude Desktop, and your AI gets a research pipeline that searches the web and the places people actually talk (Reddit, X, YouTube, Hacker News, GitHub), ranks everything in one list, reads the best sources, and refuses citations it cannot verify.

[Leia em português](README.pt-BR.md)

> The tool's own messages, prompts and the method guide are in Portuguese (pt-BR) for now. Your AI reads them fine and writes the final report in the language you ask for.

## What it does

- **One-step collection (`trawl_collect`):** several query variants across several sources, one ranked list, the best sources read in full, and only the relevant passages sent back. A research that used to take ~35 tool calls fits in 5 to 10.
- **Many sources in parallel:** web (free local SearXNG), Reddit (posts and comments), Hacker News, X, YouTube (with transcripts), Discourse forums, GitHub (repos, issues, Discussions, code via grep.app/GitHub/Sourcegraph), arXiv, OpenAlex, Stack Overflow, Wikipedia, MCP Registry, SkillsMP. Votes, stars, views, citations and dates come along.
- **One ranking across sources:** relevance to the query, how much the source can be trusted (official, government, academic, docs, code, press, site, forum, blog, loose post), engagement compared within each platform, and date. Off-topic results (the "uv" Python tool vs. UV light) are filtered out.
- **Quotes the server checks:** a key finding, and any "confirmed" verdict, must carry the exact sentence from the source. The server looks for it, word for word, in the text it read itself, and refuses the finding if it is not there, returning the closest real sentence.
- **Community voice, not just pages:** the most-commented discussions are read automatically; when most results come from one subreddit, Trawl searches inside it too.
- **Official sources that need JavaScript:** read with the Chrome or Edge you already have, headless and with an empty profile. Never used against anti-bot checks. Game announcements on Steam count as official.
- **A real time window:** `since_days` on every dated source, with a final check that drops what falls outside.
- **Junk filter:** GitHub repos with bought stars are flagged ⚠ SUSPEITO and sink; cross-posted Reddit threads collapse into one.
- **Memory and radar:** `trawl_recall` shows what earlier researches found; `trawl_radar` repeats a search on a schedule and shows only what is new.
- **A research conductor:** sessions saved to disk go through plan → collect → cross-check → verify → report. `trawl_next` always says the next step, and the report refuses any citation that was not registered.

Your AI does the thinking and the writing; the server searches, stores and enforces the method. It never calls an LLM on its own (except Grok, if you turn on X search through xAI).

## Install

Requires Node 22.12+ (tested on 24).

```bash
git clone https://github.com/FFloriani/trawl.git
cd trawl
npm install
npm run build
node dist/index.js doctor
```

`doctor` shows what already works and how to turn on the rest. Keys live in `~/.trawl/.env` (template in [.env.example](.env.example)), so your IDE config never carries secrets.

### Free web search (local SearXNG)

With Docker running:

```bash
npm run searxng
```

This starts SearXNG on `http://127.0.0.1:8888` (reachable only from your machine), runs a test search and writes `SEARXNG_URL` to `~/.trawl/.env`. No key, no quota. The container comes back by itself whenever Docker starts. To stop it: `npm run searxng:stop`.

| Without any key | With a key |
|---|---|
| Web through local SearXNG, Reddit (Reddit's own search with live votes, threads with comments, comment search across Reddit via PullPush; RSS and Arctic Shift as fallbacks), Hacker News, Discourse forums, YouTube (with transcripts), GitHub (uses your `gh` login), MCP Registry, arXiv, OpenAlex, Stack Overflow, Wikipedia, reading X posts | Web through Brave, Tavily or Exa; Reddit OAuth (only with an app Reddit already approved); X search (twitterapi.io at ~US$0.15 per 1,000 posts, xAI/Grok, or the official API); SkillsMP |

Without SearXNG or a web key, your AI uses its own web search and registers the results with `trawl_add_sources`.

## Connect it to your IDE

Replace the path with yours. On Windows, use forward slashes (`C:/path/to/trawl/dist/index.js`).

**Claude Code**
```bash
claude mcp add trawl --scope user -- node "/path/to/trawl/dist/index.js"
```
Optional: copy `integrations/claude-code/skills/trawl` to `~/.claude/skills/` to get `/trawl`, which runs the collection in parallel subagents.

**Cursor** (`~/.cursor/mcp.json`), **Windsurf** (`~/.codeium/windsurf/mcp_config.json`), **Claude Desktop** (`claude_desktop_config.json`), **Gemini CLI** (`~/.gemini/settings.json`):
```json
{
  "mcpServers": {
    "trawl": {
      "command": "node",
      "args": ["/path/to/trawl/dist/index.js"]
    }
  }
}
```

**VS Code / Copilot** (`.vscode/mcp.json` or your user `mcp.json`):
```json
{
  "servers": {
    "trawl": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/trawl/dist/index.js"]
    }
  }
}
```

**Codex CLI** (`~/.codex/config.toml`):
```toml
[mcp_servers.trawl]
command = "node"
args = ["/path/to/trawl/dist/index.js"]
```

## Use

- **Full research:** the `pesquisa` prompt (in Claude Code: `/mcp__trawl__pesquisa`, or `/trawl` with the skill), or just ask "research X in depth with Trawl". The AI calls `trawl_start` and follows `trawl_next`.
- **Quick:** the `pesquisa_rapida` prompt.
- **Community only:** the `comunidade` prompt (Reddit, HN, X, YouTube and GitHub issues from the last days).
- **One-off:** `trawl_collect` (or `trawl_search` and `trawl_read`).
- **What is already known:** `trawl_recall` with the topic.
- **Follow a topic:** `trawl_radar` with `action=create`, a name and the queries. It runs right away (baseline) and then shows only what is new.

On Reddit, `subreddit:Name terms` searches inside a subreddit, with votes. Discourse forums have no default: `forum:host terms` (e.g. `forum:discuss.python.org`) or `forums` in `trawl_plan` pick the ones for the subject; `TRAWL_FORUMS` pins some for every research.

### Radar on a schedule

The MCP server only runs when the IDE calls it, so scheduling belongs to the OS. Windows, daily at 8 AM:

```bash
schtasks /Create /SC DAILY /ST 08:00 /TN "Trawl Radar" /TR "node \"C:/path/to/trawl/dist/index.js\" radar run --due"
```

On Linux/macOS, the same command (`node /path/to/trawl/dist/index.js radar run --due`) goes in cron. Each run writes a digest to `~/.trawl/radar/<name>/runs/`.

### Tools

| Tool | What it does |
|---|---|
| `trawl_doctor` | Which sources are on, and how to turn on the rest |
| `trawl_collect` | One-step collection: variants × sources, one ranking, the best read in full, relevant passages |
| `trawl_search` | Search several sources at once, in one ranking |
| `trawl_read` | Read a whole source as clean Markdown (in a session, keeps the text for quote checks) |
| `trawl_ask_repo` | Ask DeepWiki how a GitHub repo works (AI answer: confirm in the code) |
| `trawl_start` | Open a research session |
| `trawl_plan` | Register sub-questions, source layers, official domains and forums |
| `trawl_add_sources` | Register sources found outside the server |
| `trawl_add_findings` | Register findings (each with sources; key findings with a checked quote) and gaps |
| `trawl_crosscheck` | Cross-check findings: conflicts, consensus, blind spots |
| `trawl_verify` | Register the verdict for each key finding ("confirmed" needs a quote from the primary source) |
| `trawl_report` | Build the report (Markdown + HTML) and validate every citation |
| `trawl_next` | Current phase and the exact next step |
| `trawl_sessions` | List saved researches |
| `trawl_recall` | Search the findings of all earlier researches |
| `trawl_radar` | Create, run, list and delete radars |

The full method is in [docs/METHOD.md](docs/METHOD.md) (Portuguese) and is also served as the resource `trawl://metodo`.

## Where things live

- `~/.trawl/.env`: keys
- `~/.trawl/cache/`: search cache (saves quota)
- `~/.trawl/research/<date>-<topic>--<id>/`: each research: `session.json`, `sources.jsonl`, `claims.jsonl`, `gaps.jsonl`, `verifications.jsonl`, `texts/` (text of every source read), `report.md` and `report.html`
- `~/.trawl/radar/<name>/`: radar definition, URLs already seen and one digest per run

Settings can also be set as environment variables (`TRAWL_HOME`, `TRAWL_FORUMS`, `TRAWL_BROWSER`, …); see [.env.example](.env.example).

## Command line

```bash
node dist/index.js search "deep research agent" --sources reddit,hn,github --days 30
node dist/index.js read https://news.ycombinator.com/item?id=49303046
node dist/index.js radar run --due
```

A real example: [docs/exemplos](docs/exemplos) has a report produced end to end by the server (71 sources, 26 findings, 10 verified).

## Responsible use

- Trawl reads public pages and public APIs, at a polite pace (per-host rate limits, caching, `Retry-After` honored).
- It never solves CAPTCHAs, never forges anti-bot tokens and never uses the headless browser against a bot check. Sources that block it are reported as gaps.
- The optional `REDDIT_COOKIE` uses your own logged-in Reddit session to get fuller results. That goes against Reddit's terms and can put your account at risk; it is off unless you set it.
- Respect the terms of the sites and APIs you turn on.

## Development

```bash
npm run typecheck
npm test            # unit tests, no network
npm run test:live   # a real MCP client against the built server, with real APIs (build first)
npm run dev         # run straight from TypeScript (Node 24)
node scripts/call.mjs trawl_doctor '{}'   # call any tool over real MCP, like an IDE would
```

Stack: TypeScript on Node, `@modelcontextprotocol/sdk` pinned to 1.32.1 (protocol 2025-11-25), Readability + Turndown for pages, linkedom, fast-xml-parser, marked.

## Credits

Trawl stands on other people's work and ideas:

- [mvanhorn/last30days-skill](https://github.com/mvanhorn/last30days-skill): the idea of "what people said in the last N days" research and the approach of searching Reddit through its own web fragments.
- [jdepoix/youtube-transcript-api](https://github.com/jdepoix/youtube-transcript-api): the method for fetching YouTube transcripts.
- [Arctic Shift](https://github.com/ArthurHeitmann/arctic_shift) and [PullPush](https://pullpush.io): Reddit archives and comment search.
- [FxTwitter](https://github.com/FxEmbed/FxEmbed): free reading of X posts.
- [SearXNG](https://github.com/searxng/searxng), [DeepWiki](https://deepwiki.com), [grep.app](https://grep.app), [Sourcegraph](https://sourcegraph.com), [HN Algolia](https://hn.algolia.com/api), [OpenAlex](https://openalex.org), [arXiv](https://arxiv.org), [Stack Exchange](https://api.stackexchange.com), [Wikipedia](https://www.wikipedia.org), the [MCP Registry](https://registry.modelcontextprotocol.io).

## License

[MIT](LICENSE)
