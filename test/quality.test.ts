import { describe, expect, it } from "vitest";
import { insideWindow } from "../src/connectors/index.ts";
import { markStarClusters, repoRedFlags } from "../src/connectors/github.ts";
import { dedupeCrossposts } from "../src/connectors/reddit.ts";
import { extractJsonVar, findVideos, parseCount, relativeToDate } from "../src/connectors/youtube.ts";
import type { SearchHit } from "../src/core/types.ts";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

describe("suspicious GitHub repos", () => {
  // Real pattern seen on 2026-10-11: four repos created 2026-09-22, 70 stars, 0 forks, HTML.
  const fake = (name: string) => ({
    name,
    stargazers_count: 70,
    forks_count: 0,
    language: "HTML",
    description: "Best Open-Source AI Roblox Studio Copilot 2026",
    created_at: "2026-09-22T10:00:00Z",
  });
  const real = { name: "real", stargazers_count: 290, forks_count: 46, language: "Lua", description: "MCP server for Roblox Studio", created_at: "2026-05-23T00:00:00Z" };

  it("flags star-farmed repos and leaves healthy ones alone", () => {
    expect(repoRedFlags(fake("a"), NOW).length).toBeGreaterThanOrEqual(2);
    expect(repoRedFlags(real, NOW)).toEqual([]);
  });

  it("detects siblings created the same day with the same stars", () => {
    const list = [fake("a"), fake("b"), real];
    const clusters = markStarClusters(list);
    expect(clusters.get(list[0]!)).toBe(true);
    expect(clusters.get(list[1]!)).toBe(true);
    expect(clusters.get(real)).toBeUndefined();
  });
});

describe("since_days window", () => {
  const hit = (published: string | undefined, tags: string[] = []): SearchHit => ({ url: "https://x.test", title: "t", source: "web", provider: "p", published, tags });

  it("drops dated hits outside the window and keeps undated ones", () => {
    expect(insideWindow(hit(daysAgo(10)), 30, NOW)).toBe(true);
    expect(insideWindow(hit(daysAgo(45)), 30, NOW)).toBe(false);
    expect(insideWindow(hit(undefined), 30, NOW)).toBe(true);
  });

  it("gives approximate dates (YouTube '1mo ago') some slack", () => {
    expect(insideWindow(hit(daysAgo(34), ["data aproximada (1mo ago)"]), 30, NOW)).toBe(true);
    expect(insideWindow(hit(daysAgo(34)), 30, NOW)).toBe(false);
  });
});

describe("reddit crossposts", () => {
  it("merges the same post shared to several subreddits", () => {
    const h = (sub: string): SearchHit => ({
      url: `https://www.reddit.com/r/${sub}/comments/x${sub}/t`,
      title: "v0.8.6 rbx-studio-mcp now lets you sync files",
      author: "EL4CTEO",
      source: "reddit",
      provider: "rss",
      tags: [`r/${sub}`],
    });
    const out = dedupeCrossposts([h("RobloxDevelopers"), h("ROBLOXStudio")]);
    expect(out).toHaveLength(1);
    expect(out[0]?.tags).toContain("também em r/ROBLOXStudio");
  });
});

describe("youtube parsing", () => {
  it("converts relative dates in both compact and long forms", () => {
    expect(relativeToDate("2w ago", NOW)?.slice(0, 10)).toBe("2026-09-27");
    expect(relativeToDate("Streamed 3 days ago", NOW)?.slice(0, 10)).toBe("2026-10-08");
    expect(relativeToDate("1mo ago", NOW)?.slice(0, 10)).toBe("2026-09-11");
    expect(relativeToDate("yesterday", NOW)).toBeUndefined();
  });

  it("parses view counts", () => {
    expect(parseCount("7,470 views")).toBe(7470);
    expect(parseCount("1.2K views")).toBe(1200);
    expect(parseCount("3M views")).toBe(3_000_000);
  });

  it("extracts the data blob even with braces inside strings", () => {
    const html = `<script>var ytInitialData = {"a":{"videoRenderer":{"videoId":"abc","title":{"runs":[{"text":"brace } inside \\" quote"}]}}}};</script>`;
    const data = extractJsonVar(html, "ytInitialData");
    const videos = findVideos(data);
    expect(videos.map((v) => v.videoId)).toEqual(["abc"]);
    expect(videos[0]?.title?.runs?.[0]?.text).toBe('brace } inside " quote');
  });
});

describe("report and session fixes found in the Roblox research run", () => {
  it("reads the title of a Markdown page from front matter or the first heading", async () => {
    const { textTitle } = await import("../src/connectors/reader.ts");
    expect(textTitle('---\ntitle: "Connect to the Roblox Studio MCP server"\nurl: /x\n---\n# Other')).toBe("Connect to the Roblox Studio MCP server");
    expect(textTitle("intro\n# Heading here\ntext")).toBe("Heading here");
    expect(textTitle("no title at all")).toBeUndefined();
  });

  it("keeps a real title when a later record only carries the URL", async () => {
    const { createSession, addSources, loadSession } = await import("../src/pipeline/session.ts");
    const { meta } = await createSession({ question: "título preservado", depth: "quick" });
    const url = "https://create.roblox.com/docs/en-us/studio/mcp.md";
    const base = { id: "Sabc123", url, source: "page" as const, provider: "host", subquestions: [], addedAt: new Date().toISOString() };
    await addSources(meta.id, [{ ...base, title: "Doc oficial do Studio MCP" }]);
    await addSources(meta.id, [{ ...base, title: url, readAt: new Date().toISOString() }]);
    const s = (await loadSession(meta.id)).sources.get("Sabc123");
    expect(s?.title).toBe("Doc oficial do Studio MCP");
    expect(s?.readAt).toBeTruthy();
  });

  it("collection briefs skip switched-off sources and point web to the IDE search", async () => {
    const { collectionBrief } = await import("../src/pipeline/phases.ts");
    const brief = collectionBrief("ss-abcdef", { id: "Q1", question: "q", layers: ["official", "community"] }, "standard", 30, [], new Set(["reddit", "hn", "forums", "youtube"]));
    expect(brief).toContain('sources=["reddit","hn","forums","youtube"]');
    expect(brief).toMatch(/Desligadas nesta máquina: web(, \w+)*\./);
    expect(brief).toMatch(/Desligadas[^\n]*\bx\b/);
    expect(brief).toContain("busca web nativa");
  });
});

describe("reddit via Arctic Shift", () => {
  it("extracts search terms without stopwords", async () => {
    const { searchTerms } = await import("../src/connectors/arcticshift.ts");
    expect(searchTerms("Claude para Roblox Studio and the MCP")).toEqual(["claude", "roblox", "studio", "mcp"]);
  });

  it("filters listed posts locally: enough terms, best matches first", async () => {
    const { filterByTerms } = await import("../src/connectors/arcticshift.ts");
    const post = (id: string, title: string, score = 0) => ({ id, title, subreddit: "x", created_utc: 0, score, num_comments: 0 });
    const out = filterByTerms(
      [post("a", "Claude built my Roblox map", 1), post("b", "Roblox lag help", 50), post("c", "Claude + Roblox + Blender pipeline", 3)],
      ["claude", "roblox", "blender"],
    );
    expect(out.map((p) => p.id)).toEqual(["c", "a"]);
  });

  it("treats 422 'slow down' and 429 as budget errors, not outages", async () => {
    const { isBudgetError } = await import("../src/connectors/arcticshift.ts");
    const { HttpError } = await import("../src/core/http.ts");
    expect(isBudgetError(new HttpError("HTTP 422 from x: Timeout. Maybe slow down a bit", 422, "u", 40))).toBe(true);
    expect(isBudgetError(new HttpError("HTTP 429 de x", 429, "u"))).toBe(true);
    expect(isBudgetError(new HttpError("HTTP 400 from x: bad param", 400, "u"))).toBe(false);
  });
});

describe("youtube transcripts", () => {
  it("prefers manual captions, then English, then Portuguese", async () => {
    const { pickTrack } = await import("../src/connectors/youtube.ts");
    const t = (languageCode: string, kind?: string) => ({ baseUrl: `u-${languageCode}-${kind ?? "manual"}`, languageCode, kind });
    expect(pickTrack([t("en", "asr"), t("pt"), t("de")])?.baseUrl).toBe("u-pt-manual");
    expect(pickTrack([t("de", "asr"), t("en", "asr")])?.baseUrl).toBe("u-en-asr");
    expect(pickTrack([])).toBeUndefined();
  });

  it("turns caption XML into timestamped paragraphs and decodes double entities", async () => {
    const { transcriptFromXml } = await import("../src/connectors/youtube.ts");
    const xml = '<transcript><text start="0.5" dur="2">I&amp;#39;m going</text><text start="12" dur="3">to show</text><text start="31" dur="2">the setup</text><text start="65" dur="2">next part</text></transcript>';
    expect(transcriptFromXml(xml)).toBe("[00:00] I'm going to show the setup\n[01:05] next part");
  });
});

describe("github research upgrades", () => {
  it("parses grep.app answers into code hits", async () => {
    const { parseGrepApp } = await import("../src/connectors/github.ts");
    const text = [
      "Repository: Roblox/creator-docs",
      "Path: content/en-us/studio/mcp.md",
      "URL: https://github.com/Roblox/creator-docs/blob/main/content/en-us/studio/mcp.md",
      "License: CC-BY-4.0",
      "",
      "Snippets:",
      "--- Snippet 1 (Line 40) ---",
      "| `generate_procedural_model` | Creates 3D objects |",
      "",
      "Repository: a/b",
      "Path: x.lua",
      "URL: https://github.com/a/b/blob/main/x.lua",
      "License: Unknown",
      "",
      "Snippets:",
      "--- Snippet 1 (Line 1) ---",
      "print(1)",
    ].join("\n");
    const out = parseGrepApp(text);
    expect(out.map((m) => m.repo)).toEqual(["Roblox/creator-docs", "a/b"]);
    expect(out[0]?.snippet).toContain("generate_procedural_model");
    expect(out[0]?.license).toBe("CC-BY-4.0");
  });

  it("maps a GraphQL discussion to a hit with votes and answer state", async () => {
    const { discussionToHit } = await import("../src/connectors/github.ts");
    const hit = discussionToHit({
      title: "MCP tools missing",
      url: "https://github.com/o/r/discussions/7",
      upvoteCount: 12,
      createdAt: "2026-10-01T00:00:00Z",
      isAnswered: true,
      comments: { totalCount: 4 },
      repository: { nameWithOwner: "o/r" },
      category: { name: "Q&A" },
    });
    expect(hit.source).toBe("github_discussions");
    expect(hit.metrics).toEqual({ likes: 12, comments: 4 });
    expect(hit.tags).toEqual(["o/r", "Q&A", "respondida"]);
  });
});

describe("grep.app filters", () => {
  it("splits repo:, path: and lang: out of the query", async () => {
    const { grepAppArgs } = await import("../src/connectors/github.ts");
    expect(grepAppArgs("repo:TabooHarmony/roblox-brain path:skills lang:Markdown generate_mesh")).toEqual({
      query: "generate_mesh",
      useRegexp: false,
      repo: "TabooHarmony/roblox-brain",
      path: "skills",
      language: ["Markdown"],
    });
    expect(grepAppArgs("generate_(mesh|material)").useRegexp).toBe(true);
  });
});

describe("reddit via its own web fragments (shreddit)", async () => {
  const { readFileSync } = await import("node:fs");
  const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
  const shreddit = await import("../src/connectors/shreddit.ts");

  it("parses search results with live votes, comments and dates", () => {
    const { posts } = shreddit.parseSearchPage(fx("shreddit-search.html"));
    expect(posts.length).toBeGreaterThanOrEqual(3);
    const p = posts[0]!;
    expect(p.url).toMatch(/^https:\/\/www\.reddit\.com\/r\/\w+\/comments\/[a-z0-9]+\//);
    expect(typeof p.score).toBe("number");
    expect(typeof p.comments).toBe("number");
    expect(p.created).toMatch(/^20\d\d-/);
  });

  it("reads the next-page cursor from the search partial", () => {
    const html = '<faceplate-partial loading="lazy" src="/svc/shreddit/search/?q=x&amp;type=posts&amp;cursor=abc123"></faceplate-partial>';
    expect(shreddit.parseSearchPage(html).cursor).toBe("abc123");
  });

  it("parses subreddit listing cards (score 469, 71 comments on the first)", () => {
    const posts = shreddit.parseListing(fx("shreddit-listing.html"));
    expect(posts[0]).toMatchObject({ id: "1wnbdyi", score: 469, comments: 71, subreddit: "robloxgamedev", author: "maix_go" });
  });

  it("parses comments with author, live score, depth and body", () => {
    const comments = shreddit.parseComments(fx("shreddit-comments.html"));
    expect(comments[0]).toMatchObject({ author: "Doowoo", score: 47, depth: 0 });
    expect(comments[0]?.text).toContain("delusion");
    expect(comments.some((c) => c.depth > 0)).toBe(true);
  });

  it("finds start tags even with '>' inside quoted attributes, and skips longer element names", () => {
    const html = '<shreddit-comments-page-ad id="ad"></shreddit-comments-page-ad><shreddit-post post-title="a -> b" score="5"></shreddit-post>';
    expect(shreddit.findStartTags(html, "shreddit-post").map((t) => shreddit.attr(t.tag, "post-title"))).toEqual(["a -> b"]);
    expect(shreddit.findStartTags(html, "shreddit-comment")).toEqual([]);
  });

  it("canonicalizes thread URLs so search and read share one source id", async () => {
    const { sourceId } = await import("../src/core/util.ts");
    expect(sourceId("https://www.reddit.com/r/aigamedev/comments/1x0k32m/built_an_age_of_sail/")).toBe(sourceId("https://www.reddit.com/r/aigamedev/comments/1x0k32m/"));
  });
});

describe("pullpush comments", () => {
  it("maps a comment to a hit and drops removed ones", async () => {
    const { commentToHit } = await import("../src/connectors/pullpush.ts");
    const hit = commentToHit({ id: "c1", body: "just connect the Roblox studio MCP", author: "a", subreddit: "robloxgamedev", created_utc: 1758800000, permalink: "/r/robloxgamedev/comments/p1/t/c1/" });
    expect(hit).toMatchObject({ source: "reddit_comments", url: "https://www.reddit.com/r/robloxgamedev/comments/p1/t/c1/" });
    expect(commentToHit({ id: "c2", body: "[removed]" })).toBeUndefined();
  });
});

describe("logged-in reddit: site + JSON search merged", () => {
  it("interleaves two ranked lists, one copy per thread, keeping the fuller record", async () => {
    const { interleaveUnique } = await import("../src/connectors/reddit.ts");
    const h = (id: string, author?: string) => ({ url: `https://www.reddit.com/r/x/comments/${id}/t/`, title: id, source: "reddit" as const, provider: "p", author, metrics: { score: 1 } });
    const out = interleaveUnique([[h("a"), h("b"), h("c")], [h("b", "bob"), h("d", "dan")]]);
    expect(out.map((x) => x.title)).toEqual(["a", "b", "d", "c"]);
    expect(out.find((x) => x.title === "b")?.author).toBe("bob");
  });
});

describe("x via twitterapi.io", async () => {
  const { readFileSync } = await import("node:fs");
  const { twapiQuery, twapiToHit } = await import("../src/connectors/x-twitterapi.ts");

  it("builds the query: no retweets, window rounded to the day, Top unless sort:latest", () => {
    const now = Date.parse("2026-10-11T15:30:00Z");
    const a = twapiQuery("roblox claude", 30, now);
    expect(a.queryType).toBe("Top");
    expect(a.query).toBe("roblox claude -filter:retweets since_time:1789084800");
    expect(twapiQuery("roblox claude", 30, now + 3_600_000).query).toBe(a.query); // same day → same cache key
    expect(twapiQuery("x sort:latest", undefined, now)).toEqual({ query: "x -filter:retweets", queryType: "Latest" });
    expect(twapiQuery("x since:2026-10-01 include:nativeretweets", 7, now).query).toBe("x since:2026-10-01 include:nativeretweets");
  });

  it("maps a real search page to hits with metrics and an ISO date", () => {
    const page = JSON.parse(readFileSync(new URL("./fixtures/twitterapi-search.json", import.meta.url), "utf8"));
    const hits = page.tweets.map(twapiToHit);
    expect(hits[0].url).toMatch(/^https:\/\/x\.com\/\w+\/status\/\d+$/);
    expect(hits[0].published).toMatch(/^2026-\d\d-\d\dT/);
    expect(typeof hits[0].metrics.likes).toBe("number");
    expect(typeof hits[0].metrics.views).toBe("number");
    expect(hits[0].tags.some((t: string) => t.startsWith("lang:"))).toBe(true);
  });
});
