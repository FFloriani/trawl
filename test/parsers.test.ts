import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { arxivIdFromUrl, arxivQuery } from "../src/connectors/arxiv.ts";
import { cleanReadme } from "../src/connectors/github.ts";
import { rebuildAbstract } from "../src/connectors/openalex.ts";
import { parseAtom, redditThreadId, splitSubreddit } from "../src/connectors/reddit.ts";
import { collectPostUrls, outputText, parseGrokPosts } from "../src/connectors/x.ts";
import { htmlToMarkdown } from "../src/core/extract.ts";
import { decodeEntities, normalizeUrl, slugify, sourceId } from "../src/core/util.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("normalizeUrl / sourceId", () => {
  it("maps the same page to the same id across variants", () => {
    const a = "https://old.reddit.com/r/ClaudeAI/comments/abc123/title/?utm_source=x#c";
    const b = "https://www.reddit.com/r/ClaudeAI/comments/abc123";
    expect(normalizeUrl(a)).toBe(b);
    expect(sourceId(a)).toBe(sourceId(b));
    expect(sourceId(a)).toMatch(/^S[0-9a-z]{6}$/);
  });

  it("folds twitter.com into x.com and arXiv pdf/version into abs", () => {
    expect(normalizeUrl("https://twitter.com/user/status/123?s=20")).toBe("https://x.com/user/status/123");
    expect(normalizeUrl("https://arxiv.org/pdf/2401.01234v3")).toBe("https://arxiv.org/abs/2401.01234");
  });

  it("keeps meaningful query params", () => {
    expect(normalizeUrl("https://news.ycombinator.com/item?id=42&utm_medium=x")).toBe("https://news.ycombinator.com/item?id=42");
  });
});

describe("text helpers", () => {
  it("slugify keeps accents and drops Windows-forbidden characters", () => {
    expect(slugify('Pesquisa: "ação" <teste>/x?')).toBe("pesquisa-ação-teste-x");
  });
  it("decodes numeric and named entities", () => {
    expect(decodeEntities("a &amp; b &#39;c&#39; &#x41;")).toBe("a & b 'c' A");
  });
});

describe("reddit", () => {
  it("parses the search feed and keeps posts only (t3_)", () => {
    const entries = parseAtom(fixture("reddit-search.rss"));
    expect(entries.length).toBeGreaterThan(1);
    const posts = entries.filter((e) => e.id?.startsWith("t3_"));
    expect(posts.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.id?.startsWith("t5_"))).toBe(true);
  });

  it("parses a thread feed: post first, then comments", () => {
    const entries = parseAtom(fixture("reddit-thread.rss"));
    expect(entries[0]?.id?.startsWith("t3_")).toBe(true);
    expect(entries.filter((e) => e.id?.startsWith("t1_")).length).toBeGreaterThan(5);
  });

  it("splits subreddit scoping from the query", () => {
    expect(splitSubreddit("subreddit:ClaudeAI rate limits")).toEqual({ subreddit: "ClaudeAI", rest: "rate limits" });
    expect(splitSubreddit("best mcp r/LocalLLaMA")).toEqual({ subreddit: "LocalLLaMA", rest: "best mcp" });
    expect(splitSubreddit("no scope here")).toEqual({ rest: "no scope here" });
  });

  it("extracts thread ids", () => {
    expect(redditThreadId("https://www.reddit.com/r/x/comments/1wye4ix/slug/")).toBe("1wye4ix");
  });
});

describe("arxiv / openalex", () => {
  it("builds an AND query and keeps phrases", () => {
    expect(arxivQuery('deep research "tool use"')).toBe('all:deep AND all:research AND all:"tool use"');
  });
  it("reads ids from abs and pdf urls", () => {
    expect(arxivIdFromUrl("https://arxiv.org/pdf/2401.01234v2.pdf")).toBe("2401.01234");
    expect(arxivIdFromUrl("https://arxiv.org/abs/2610.12419")).toBe("2610.12419");
  });
  it("rebuilds an inverted-index abstract", () => {
    expect(rebuildAbstract({ agents: [1], Deep: [0], search: [2] })).toBe("Deep agents search");
  });
});

describe("x (grok output)", () => {
  const resp = {
    output: [
      { type: "x_search_call" },
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: 'Here you go:\n[{"url":"https://x.com/alice/status/111","author":"@alice","text":"hello","likes":5}]',
            annotations: [{ type: "url_citation", url: "https://twitter.com/bob/status/222" }],
          },
        ],
      },
    ],
  };
  it("collects every cited post url, normalized to x.com", () => {
    expect([...collectPostUrls(resp)].sort()).toEqual(["https://x.com/alice/status/111", "https://x.com/bob/status/222"]);
  });
  it("parses the JSON list out of the model text", () => {
    const posts = parseGrokPosts(outputText(resp));
    expect(posts).toHaveLength(1);
    expect(posts[0]?.likes).toBe(5);
  });
});

describe("extract", () => {
  it("turns an article into markdown with absolute links", () => {
    const html = `<html><head><title>T</title><meta property="article:published_time" content="2026-01-02"></head>
      <body><nav>menu</nav><article><h1>Head</h1>${"<p>Some long paragraph of real content here. </p>".repeat(20)}
      <p><a href="/docs/page">link</a></p></article></body></html>`;
    const out = htmlToMarkdown(html, "https://example.com/blog/post");
    expect(out.published).toBe("2026-01-02");
    expect(out.markdown).toContain("https://example.com/docs/page");
    expect(out.markdown).not.toContain("menu");
  });

  it("removes badge rows from READMEs", () => {
    const md = "[![CI](https://x/badge.svg)](https://x) [![npm](https://y.svg)](https://y)\n# Title\n<div align=center>text</div>";
    expect(cleanReadme(md)).toBe("# Title\ntext");
  });
});
