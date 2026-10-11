import { describe, expect, it } from "vitest";
import { forums, forumHostsIn } from "../src/connectors/forums.ts";
import { steamMarkup, steamNewsAppId, steamNewsPostId } from "../src/connectors/steam.ts";
import { looksLikeChallenge } from "../src/core/browser.ts";
import { snippetDate } from "../src/connectors/web.ts";
import { closestPassage, numbersIn, queryTerms, quoteInText, stem, topPassages } from "../src/core/text.ts";
import type { SearchHit } from "../src/core/types.ts";
import { dominantSubreddit, queryAnchors, subredditQuery, topDiscussions } from "../src/pipeline/collect.ts";
import { checkQuote } from "../src/pipeline/evidence.ts";
import { collectionBrief } from "../src/pipeline/phases.ts";
import { digestMarkdown, isDue, onlyNew, windowDays, type Radar } from "../src/pipeline/radar.ts";
import { pickToRead, rankHits, trustTier } from "../src/pipeline/rank.ts";
import { recall, scoreDocs } from "../src/pipeline/recall.ts";
import { renderReport } from "../src/pipeline/report.ts";
import {
  addFindings,
  addSources,
  addVerifications,
  createSession,
  hitToSource,
  loadSession,
  loadSourceText,
  saveSourceText,
  updateMeta,
} from "../src/pipeline/session.ts";

const hit = (url: string, source: SearchHit["source"], extra: Partial<SearchHit> = {}): SearchHit => ({
  url,
  title: `Title of ${url}`,
  source,
  provider: "test",
  ...extra,
});

const SOURCE = `# Release notes

The new resolver is **10x faster** than the old one on cold caches, according to [our benchmark](https://example.com/bench).

Teams reported that “migration took less than an hour” in most projects.

## Limits
It still lacks support for editable installs of legacy packages.`;

describe("literal quote check", () => {
  it("accepts the exact words whatever the markdown, quotes, case or accents", () => {
    expect(quoteInText(SOURCE, "The new resolver is 10x faster than the old one").ok).toBe(true);
    expect(quoteInText(SOURCE, "10x faster than the old one on cold caches, according to our benchmark").ok).toBe(true);
    expect(quoteInText(SOURCE, '"Migration took less than an hour" in most projects').ok).toBe(true);
    expect(quoteInText("Ação concluída com êxito em três etapas", "acao concluida com exito em tres").ok).toBe(true);
  });

  it("accepts pieces joined by an ellipsis only in the original order", () => {
    expect(quoteInText(SOURCE, "The new resolver is ... according to our benchmark").ok).toBe(true);
    expect(quoteInText(SOURCE, "according to our benchmark … The new resolver is").ok).toBe(false);
  });

  it("refuses paraphrases, translations and quotes too short to mean anything", () => {
    expect(quoteInText(SOURCE, "The new resolver is ten times faster than before").ok).toBe(false);
    expect(quoteInText(SOURCE, "O novo resolvedor é 10x mais rápido").ok).toBe(false);
    expect(quoteInText(SOURCE, "10x faster").reason).toMatch(/curta/);
    expect(quoteInText(SOURCE, "The new resolver is ... cold caches").reason).toMatch(/3 palavras/);
  });

  it("points to the closest real sentence when a quote fails", () => {
    expect(closestPassage(SOURCE, "the resolver is ten times faster than the old one")).toContain("10x faster");
  });

  it("extracts the numbers a stat must quote", () => {
    expect(numbersIn("cresceu 40% em 2026, de 1,5 para 2.1")).toEqual(["40", "2026", "1.5", "2.1"]);
  });
});

describe("passages", () => {
  it("returns the matching blocks in document order, with the heading attached", () => {
    const p = topPassages(SOURCE, queryTerms("editable installs legacy", "resolver benchmark"), 2, 600);
    expect(p).toHaveLength(2);
    expect(p[0]).toContain("benchmark");
    expect(p[1]).toContain("## Limits");
    expect(p[1]).toContain("editable installs");
  });

  it("cuts long blocks around the first match on word boundaries", () => {
    const long = `${"filler words here ".repeat(80)}the key phrase sits here ${"more filler text ".repeat(80)}`;
    const [p] = topPassages(long, ["key", "phrase"], 1, 200);
    expect(p!.length).toBeLessThanOrEqual(210);
    expect(p).toContain("key phrase");
    expect(p!.startsWith("… ")).toBe(true);
  });
});

describe("cross-source ranking", () => {
  it("assigns trust tiers from platform, domain and the research's official sources", () => {
    expect(trustTier(hit("https://docs.astral.sh/uv/", "web"), ["astral.sh"])).toBe("oficial");
    expect(trustTier(hit("https://github.com/astral-sh/uv", "github"), ["github.com/astral-sh"])).toBe("oficial");
    expect(trustTier(hit("https://github.com/other/uv", "github"), ["github.com/astral-sh"])).toBe("código");
    expect(trustTier(hit("https://www.cdc.gov/x", "web"))).toBe("governo");
    expect(trustTier(hit("https://pubmed.ncbi.nlm.nih.gov/1", "web"))).toBe("acadêmico");
    expect(trustTier(hit("https://docs.python.org/3/", "web"))).toBe("documentação");
    expect(trustTier(hit("https://www.theverge.com/a", "web"))).toBe("imprensa");
    expect(trustTier(hit("https://medium.com/@a/b", "web"))).toBe("blog");
    expect(trustTier(hit("https://www.reddit.com/r/x/comments/1", "page"))).toBe("fórum");
    expect(trustTier(hit("https://github.com/a/b", "github", { tags: ["⚠ SUSPEITO: estrelas sem forks"] }))).toBe("suspeito");
  });

  it("puts the relevant official source above a relevant blog, and scores relevance per query variant", () => {
    const blog = hit("https://medium.com/@x/uv-vs-poetry", "web", { title: "uv vs poetry: which to use" });
    const docs = hit("https://docs.astral.sh/uv/", "web", { title: "uv python package manager" });
    const off = hit("https://example.org/garden", "web", { title: "gardening tips" });
    const ranked = rankHits([blog, off, docs], { terms: queryTerms("uv python package manager", "uv vs poetry"), termSets: [queryTerms("uv python package manager"), queryTerms("uv vs poetry")], officialDomains: ["astral.sh"] });
    expect(ranked.map((r) => r.hit.url)).toEqual([docs.url, blog.url, off.url]);
    expect(ranked[0]!.parts.relevance).toBe(1);
  });

  it("compares engagement inside the same platform and prefers fresh hits in a window", () => {
    const now = Date.parse("2026-10-11T00:00:00Z");
    const big = hit("https://www.reddit.com/r/a/comments/1", "reddit", { title: "topic", metrics: { score: 900 }, published: "2026-10-10T00:00:00Z" });
    const small = hit("https://www.reddit.com/r/a/comments/2", "reddit", { title: "topic", metrics: { score: 3 }, published: "2026-10-10T00:00:00Z" });
    const old = hit("https://www.reddit.com/r/a/comments/3", "reddit", { title: "topic", metrics: { score: 900 }, published: "2026-09-12T00:00:00Z" });
    const ranked = rankHits([small, old, big], { terms: ["topic"], sinceDays: 30, now });
    // Same votes: the fresher wins. Inside the window, 900 votes from last month still beat 3 from yesterday.
    expect(ranked.map((r) => r.hit)).toEqual([big, old, small]);
  });

  it("reads at most one source per site before repeating a site, and never suspicious repos", () => {
    const ranked = rankHits(
      [
        hit("https://a.com/1", "web", { title: "x y" }),
        hit("https://a.com/2", "web", { title: "x y" }),
        hit("https://b.com/1", "web", { title: "x" }),
        hit("https://github.com/s/s", "github", { title: "x y", tags: ["⚠ SUSPEITO"] }),
      ],
      { terms: ["x", "y"] },
    );
    expect(pickToRead(ranked, 2).map((r) => r.hit.url)).toEqual(["https://a.com/1", "https://b.com/1"]);
  });

  it("pulls the date out of Google-style snippets", () => {
    const now = Date.parse("2026-10-11T00:00:00Z");
    expect(snippetDate("Oct 18, 2025 ... Poetry creates a lock file", now)).toEqual({ published: new Date("Oct 18, 2025").toISOString(), snippet: "Poetry creates a lock file" });
    expect(snippetDate("3 days ago ... news", now).published).toBe("2026-10-08T00:00:00.000Z");
    expect(snippetDate("2 months ago ... x", now).approx).toBe(true);
    expect(snippetDate("No date here", now)).toEqual({ snippet: "No date here" });
  });
});

describe("forums are chosen per research", () => {
  it("reads forum:host tokens and refuses to search without a forum", async () => {
    expect(forumHostsIn("mcp server forum:discuss.python.org forum:https://community.openai.com/x")).toEqual(["discuss.python.org", "community.openai.com"]);
    await expect(forums.search({ query: "anything", limit: 3 })).rejects.toThrow(/nenhum fórum/);
    await expect(forums.search({ query: "x forum:localhost", limit: 3 })).rejects.toThrow(/inválido/);
    expect((await forums.availability()).ok).toBe(false);
  });
});

describe("quotes checked against what the server read", () => {
  it("keeps source texts per session and checks quotes against them", async () => {
    const { meta } = await createSession({ question: "teste de citações", depth: "quick" });
    const src = hitToSource(hit("https://example.com/notes", "web", { snippet: "Search excerpt: the cache now survives restarts across machines." }));
    await addSources(meta.id, [src]);
    await saveSourceText(meta.id, src.id, SOURCE);
    expect(await loadSourceText(meta.id, src.id)).toBe(SOURCE);
    await expect(saveSourceText(meta.id, "../escape", "x")).rejects.toThrow(/inválido/);

    const good = await checkQuote(meta.id, src, "It still lacks support for editable installs");
    expect(good).toMatchObject({ ok: true, quote: { checked: "text" } });
    const fromExcerpt = await checkQuote(meta.id, src, "the cache now survives restarts across machines");
    expect(fromExcerpt).toMatchObject({ ok: true, quote: { checked: "snippet" } });
    const bad = await checkQuote(meta.id, src, "It fully supports editable installs of legacy packages");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.closest).toContain("editable installs");
  });

  it("labels a quote it could not check when the source cannot be read", async () => {
    const { meta } = await createSession({ question: "fonte ilegível", depth: "quick" });
    const src = hitToSource(hit("http://127.0.0.1:9/offline", "web"));
    const r = await checkQuote(meta.id, src, "some sentence that cannot be checked here");
    expect(r).toMatchObject({ ok: true, quote: { checked: "unreadable" } });
  });

  it("shows the proof under each confirmed claim in the report", async () => {
    const { meta } = await createSession({ question: "relatório com prova", depth: "quick" });
    const src = hitToSource(hit("https://example.com/proof", "web"));
    await addSources(meta.id, [src]);
    await updateMeta(meta.id, (m) => {
      m.plan = { subquestions: [{ id: "Q1", question: "q", layers: ["official"] }], at: new Date().toISOString() };
    });
    const quote = { source: src.id, text: "The new resolver is 10x faster", checked: "text" as const };
    const { claims } = await addFindings(meta.id, "Q1", [{ text: "O resolvedor é 10x mais rápido", kind: "stat", sources: [src.id], key: true, quotes: [quote] }], []);
    await addVerifications(meta.id, [{ claim: claims[0]!.id, verdict: "confirmed", quote, at: new Date().toISOString() }]);
    const r = renderReport(await loadSession(meta.id), { title: "t", summary: `Resumo com fonte [${src.id}].`, sections: [{ heading: "h", body: "b" }] });
    expect(r.md).toContain("1 com citação literal conferida");
    expect(r.md).toContain("“The new resolver is 10x faster” ([example.com](https://example.com/proof))");
  });
});

describe("recall across researches", () => {
  it("scores documents by coverage of the query terms", () => {
    const docs = [{ tokens: ["sqlite", "wal", "mode"] }, { tokens: ["postgres", "vacuum"] }];
    const scored = scoreDocs(docs, ["sqlite", "wal"]);
    expect(scored[0]!.coverage).toBe(1);
    expect(scored[1]!.coverage).toBe(0);
  });

  it("finds findings of earlier sessions with their verdict", async () => {
    const { meta } = await createSession({ question: "Como o SQLite lida com escrita concorrente?", depth: "quick" });
    await updateMeta(meta.id, (m) => {
      m.plan = { subquestions: [{ id: "Q1", question: "q", layers: ["official"] }], at: new Date().toISOString() };
    });
    const src = hitToSource(hit("https://sqlite.org/wal.html", "web"));
    await addSources(meta.id, [src]);
    const { claims } = await addFindings(meta.id, "Q1", [{ text: "O modo WAL permite leitores simultâneos a um escritor", kind: "fact", sources: [src.id] }], []);
    await addVerifications(meta.id, [{ claim: claims[0]!.id, verdict: "confirmed", at: new Date().toISOString() }]);
    const hits = await recall("sqlite wal escritor");
    expect(hits[0]?.sessionId).toBe(meta.id);
    expect(hits[0]?.verification?.verdict).toBe("confirmed");
    expect(await recall("receitas de bolo")).toEqual([]);
  });
});

describe("radar", () => {
  const radar: Radar = { name: "r", slug: "r", queries: ["q"], sources: ["hn"], intervalHours: 24, firstWindowDays: 7, createdAt: "2026-10-01T00:00:00Z" };
  const now = Date.parse("2026-10-11T12:00:00Z");

  it("knows when it is due and how far back to look", () => {
    expect(isDue(radar, now)).toBe(true);
    expect(windowDays(radar, now)).toBe(7);
    const ran = { ...radar, lastRun: { at: "2026-10-10T12:00:00Z", newCount: 0, total: 0, digest: "", baseline: true } };
    expect(isDue(ran, now)).toBe(true);
    expect(isDue(ran, Date.parse("2026-10-11T06:00:00Z"))).toBe(false);
    expect(windowDays(ran, now)).toBe(2);
  });

  it("shows only items never seen and published since the last run", () => {
    const ranked = rankHits(
      [
        hit("https://a.com/seen", "web", { published: "2026-10-11T00:00:00Z" }),
        hit("https://a.com/fresh", "web", { published: "2026-10-11T00:00:00Z" }),
        hit("https://a.com/old-unseen", "web", { published: "2026-10-01T00:00:00Z" }),
        hit("https://a.com/undated", "web"),
      ],
      { terms: ["x"] },
    );
    const fresh = onlyNew(ranked, { "https://a.com/seen": "2026-10-10T00:00:00Z" }, Date.parse("2026-10-10T12:00:00Z"));
    expect(fresh.map((r) => r.hit.url).sort()).toEqual(["https://a.com/fresh", "https://a.com/undated"]);
    const md = digestMarkdown({ radar, fresh, total: 4, windowDays: 2, baseline: false, errors: [] }, new Date(now));
    expect(md).toContain("2 novos de 4");
    expect(md).toContain("https://a.com/fresh");
  });
});

describe("collect: discussions, subreddit pass and sources per sub-question", () => {
  const post = (id: string, sub: string, comments: number, title = "templar build"): SearchHit =>
    hit(`https://www.reddit.com/r/${sub}/comments/${id}`, "reddit", { title, tags: [`r/${sub}`], metrics: { score: 5, comments } });

  it("finds the subreddit that dominates the Reddit results", () => {
    const hits = [post("a", "Aion2", 1), post("b", "Aion2", 1), post("c", "Aion2", 1), post("d", "Aion2", 1), post("e", "Aion2", 1), post("f", "nba", 1), post("g", "witcher", 1)];
    expect(dominantSubreddit(hits)).toBe("Aion2");
    expect(dominantSubreddit(hits.slice(4))).toBeUndefined();
  });

  it("drops the words already in the subreddit name from the query", () => {
    expect(subredditQuery("Aion2", "aion 2 templar build")).toBe("subreddit:Aion2 templar build");
    expect(subredditQuery("Python", "python")).toBe("subreddit:Python python");
    expect(subredditQuery("rust", "async runtime")).toBe("subreddit:rust async runtime");
  });

  it("lists on-topic discussions by number of comments", () => {
    const ranked = rankHits([post("a", "Aion2", 82, "my experience tanking templar build"), post("b", "Aion2", 2), post("c", "Aion2", 16, "how to keep aggro templar build"), hit("https://medium.com/x", "web", { title: "templar build" })], { terms: ["templar", "build"] });
    expect(topDiscussions(ranked).map((r) => r.hit.metrics?.comments)).toEqual([82, 16]);
  });

  it("uses the sources chosen for a sub-question instead of all of its layers", () => {
    const brief = collectionBrief("ss-abcdef", { id: "Q1", question: "q", layers: ["community"], sources: ["reddit", "youtube"] }, "standard");
    expect(brief).toContain('sources=["reddit","youtube"]');
    expect(brief).not.toContain('"hn"');
  });

  it("labels a registered page by trust tier, not by layer", () => {
    expect(trustTier({ url: "https://aion2.wiki.fextralife.com/Templar_Builds", source: "page" })).toBe("site");
    expect(trustTier({ url: "https://www.reddit.com/r/Aion2/comments/1", source: "page" })).toBe("fórum");
  });
});

describe("off-topic filter and subject vocabulary", () => {
  it("folds English verb forms so tanking meets tank", () => {
    expect(stem("tanking")).toBe("tank");
    expect(stem("played")).toBe("play");
    expect(stem("speed")).toBe("speed");
    expect(queryTerms("My experience tanking")).toContain("tank");
  });

  it("picks the subject word of each query, including another script", () => {
    const hits = [
      hit("https://www.reddit.com/r/Aion2/comments/1", "reddit", { title: "aion templar build", tags: ["r/Aion2"] }),
      hit("https://www.reddit.com/r/Aion2/comments/2", "reddit", { title: "aion global patch", tags: ["r/Aion2"] }),
      hit("https://www.reddit.com/r/lol/comments/3", "reddit", { title: "global invitational", tags: ["r/lol"] }),
      hit("https://www.youtube.com/watch?v=x", "youtube", { title: "아이온2 수호성 빌드" }),
    ];
    const sets = [queryTerms("aion 2 global templar"), queryTerms("aion 2 global patch"), queryTerms("아이온2 수호성 빌드")];
    // Terms are compared in decomposed form (NFKD), so the Korean anchor is the folded token.
    expect(queryAnchors(sets, hits)).toEqual(["aion", "aion", queryTerms("아이온2")[0]]);
  });

  it("lets a thread found inside the subject's subreddit count as on-subject", () => {
    const tank = hit("https://www.reddit.com/r/Aion2/comments/t", "reddit", { title: "My experience so far", tags: ["r/Aion2"], metrics: { comments: 82 } });
    const ranked = rankHits([tank, hit("https://www.reddit.com/r/Aion2/comments/b", "reddit", { title: "templar build", tags: ["r/Aion2"], metrics: { comments: 3 } })], { terms: ["templar", "build"] });
    expect(topDiscussions(ranked).map((r) => r.hit.url)).not.toContain(tank.url);
    expect(topDiscussions(ranked, [], new Set([tank.url]))[0]!.hit.url).toBe(tank.url);
  });
});

describe("official sources: JavaScript pages and Steam announcements", () => {
  it("never treats a bot check as content", () => {
    expect(looksLikeChallenge("<html><title>Just a moment...</title><body>Checking your browser</body></html>")).toBe(true);
    expect(looksLikeChallenge(`<html><body><article>${"patch notes ".repeat(500)}</article></body></html>`)).toBe(false);
  });

  it("finds the Steam app in news URLs and labels the feed as official", () => {
    expect(steamNewsAppId(new URL("https://api.steampowered.com/ISteamNews/GetNewsForApp/v2?appid=3393110"))).toBe("3393110");
    expect(steamNewsAppId(new URL("https://store.steampowered.com/news/app/3393110/view/123"))).toBe("3393110");
    expect(steamNewsAppId(new URL("https://store.steampowered.com/app/3393110"))).toBeUndefined();
    expect(steamNewsPostId(new URL("https://store.steampowered.com/news/app/3393110/view/1846018067937860"))).toBe("1846018067937860");
    expect(steamNewsPostId(new URL("https://store.steampowered.com/news/app/3393110"))).toBeUndefined();
    expect(trustTier({ url: "https://store.steampowered.com/news/app/3393110", source: "page" })).toBe("oficial");
    expect(trustTier({ url: "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2?appid=1", source: "page" })).toBe("oficial");
  });

  it("turns Steam announcement markup into Markdown", () => {
    const md = steamMarkup("[h2]Patch[/h2][img]{STEAM_CLAN_IMAGE}/x.png[/img][list][*][b]Templar[/b]: Judgment fixed[/list][url=https://x.y]notes[/url]");
    expect(md).toContain("### Patch");
    expect(md).toContain("- **Templar**: Judgment fixed");
    expect(md).toContain("[notes](https://x.y)");
    expect(md).not.toContain("STEAM_CLAN_IMAGE");
  });
});

describe("official domains also host forums", () => {
  it("labels player posts on an official site as forum, notices as official", () => {
    const off = ["plaync.com"];
    expect(trustTier({ url: "https://aion2.plaync.com/ko-kr/board/update/view?articleId=1", source: "web" }, off)).toBe("oficial");
    expect(trustTier({ url: "https://aion2.plaync.com/ko-kr/board/free/view?articleId=1", source: "web" }, off)).toBe("fórum");
    expect(trustTier({ url: "https://aion2.plaync.com/ko-kr/board/qnanknowhow/view?articleId=1", source: "web" }, off)).toBe("fórum");
    expect(trustTier({ url: "https://lounge.plaync.com/feed/68921", source: "web" }, off)).toBe("fórum");
    expect(trustTier({ url: "https://community.openai.com/t/x/1", source: "web" })).toBe("fórum");
  });
});
