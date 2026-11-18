import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isChallengeText } from "../src/core/browser.ts";
import { subredditTarget } from "../src/connectors/reddit.ts";
import { isNetworkBlock } from "../src/connectors/reddit-session.ts";
import { counts, parseCommentSearch } from "../src/connectors/shreddit.ts";
import { redirectedAway, request } from "../src/core/http.ts";

const enc = (o: unknown) => JSON.stringify(o).replace(/"/g, "&quot;");

describe("Reddit site pages", () => {
  it("reads vote and comment counts whatever the account's language", () => {
    const en = `<faceplate-number number="184" pretty=""></faceplate-number> votes <faceplate-number number="111" pretty=""></faceplate-number> comments`;
    const pt = `<faceplate-number number="37" pretty=""></faceplate-number> votos · <faceplate-number number="5" pretty=""></faceplate-number> comentários`;
    expect(counts(en)).toEqual({ vote: 184, comment: 111 });
    expect(counts(pt)).toEqual({ vote: 37, comment: 5 });
  });

  it("reads the comment search: ids, original thread title, author, votes and the text shown", () => {
    const ctx = (type?: string) =>
      enc({
        action_info: { position: 0, ...(type ? { type } : {}) },
        comment: { id: "t1_abc123", post_id: "t3_post99" },
        post: { id: "t3_post99", title: "Original English title" },
        subreddit: { name: "ClaudeAI" },
      });
    const html = [
      `<search-telemetry-tracker data-faceplate-tracking-context="${ctx()}">`,
      `<a href="/r/ClaudeAI/">r/ClaudeAI</a> · Título traduzido`,
      `<search-telemetry-tracker data-faceplate-tracking-context="${ctx("comment")}">`,
      `<a href="#">toolhouseai</a><faceplate-partial src="/svc/shreddit/user-hover-card/toolhouseai?commentId=t1_abc123"></faceplate-partial>`,
      `<faceplate-timeago ts="2024-11-26T21:11:28.977000+0000"></faceplate-timeago>`,
      `<a href="/r/ClaudeAI/comments/post99/some_slug/abc123/"></a>`,
      `<div id="search-comment-t1_abc123-post-rtjson-content" class="i18n-search-comment-content"><p>Aqui está como eu consertei</p></div>`,
      `<faceplate-number number="2" pretty=""></faceplate-number> votos`,
    ].join("\n");
    const { comments } = parseCommentSearch(html);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      id: "abc123",
      postId: "post99",
      subreddit: "ClaudeAI",
      postTitle: "Original English title",
      author: "toolhouseai",
      score: 2,
      shownText: "Aqui está como eu consertei",
      url: "https://www.reddit.com/r/ClaudeAI/comments/post99/some_slug/abc123/",
    });
  });

  it("knows which Reddit links are a subreddit feed", () => {
    expect(subredditTarget("https://www.reddit.com/r/SwitchPirates2/")).toEqual({ subreddit: "SwitchPirates2", sort: "hot", sinceDays: undefined });
    expect(subredditTarget("https://www.reddit.com/r/SwitchPirates2/new/")).toMatchObject({ subreddit: "SwitchPirates2", sort: "new" });
    expect(subredditTarget("https://www.reddit.com/r/SwitchPirates2/new.json?limit=30&raw_json=1")).toMatchObject({ sort: "new" });
    expect(subredditTarget("https://old.reddit.com/r/ClaudeAI/top/?t=week")).toEqual({ subreddit: "ClaudeAI", sort: "top", sinceDays: 7 });
    expect(subredditTarget("https://www.reddit.com/r/ClaudeAI/top")).toMatchObject({ sort: "top", sinceDays: 1 });
    expect(subredditTarget("https://www.reddit.com/r/ClaudeAI/.rss")).toMatchObject({ sort: "hot" });
    expect(subredditTarget("https://www.reddit.com/r/ClaudeAI/comments/abc123/title/")).toBeUndefined();
    expect(subredditTarget("https://www.reddit.com/r/ClaudeAI/wiki/index")).toBeUndefined();
    expect(subredditTarget("https://example.com/r/ClaudeAI/")).toBeUndefined();
  });

  it("treats Reddit's 'prove your humanity' page as a bot check, not as content", () => {
    const logo = `[![](data:image/svg+xml;base64,${"PD94bWwg".repeat(1500)})](https://www.reddit.com)`;
    const page = `${logo}

# Prove your humanity

We’re committed to safety and security. But not for bots. Complete the challenge below and let us know you’re a real person.`;
    expect(isChallengeText(page)).toBe(true);
    expect(isChallengeText(`# Patch notes

${"The new version fixes the captcha bug in the login form. ".repeat(80)}`)).toBe(false);
  });

  it("recognizes Reddit's network-security block page", () => {
    expect(isNetworkBlock("<p>You've been blocked by network security.</p>")).toBe(true);
    expect(isNetworkBlock("<p>Search results</p>")).toBe(false);
  });
});

describe("HTTP cache", () => {
  let server: Server;
  let base = "";
  let realPage = "visitante vê a página real";

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith("/whoami")) {
        res.end(req.headers.cookie ? `logado: ${req.headers.cookie}` : "visitante");
        return;
      }
      if (req.url?.startsWith("/search")) {
        // A visitor is sent to the login page until the site "lets them in".
        if (realPage.startsWith("visitante vê")) {
          res.writeHead(302, { location: "/login" });
          res.end();
        } else res.end(realPage);
        return;
      }
      if (req.url?.startsWith("/login")) {
        res.end("faça login");
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("keeps the answers with and without a session apart", async () => {
    const anon = await request(`${base}/whoami`, { cacheTtlMs: 60_000 });
    const logged = await request(`${base}/whoami`, { cacheTtlMs: 60_000, headers: { cookie: "reddit_session=abc" } });
    expect(anon.text).toBe("visitante");
    expect(logged.text).toBe("logado: reddit_session=abc");
    expect(logged.fromCache).toBe(false);
    const again = await request(`${base}/whoami`, { cacheTtlMs: 60_000, headers: { cookie: "reddit_session=abc" } });
    expect(again.fromCache).toBe(true);
    expect(again.text).toBe("logado: reddit_session=abc");
  });

  it("never keeps a redirect to another page as the answer to the URL", async () => {
    const first = await request(`${base}/search?q=x`, { cacheTtlMs: 60_000 });
    expect(first.text).toBe("faça login");
    expect(redirectedAway(`${base}/search?q=x`, first.url)).toBe(true);
    realPage = "resultados de verdade";
    const second = await request(`${base}/search?q=x`, { cacheTtlMs: 60_000 });
    expect(second.fromCache).toBe(false);
    expect(second.text).toBe("resultados de verdade");
  });

  it("treats the same page with another query string as the same place", () => {
    expect(redirectedAway("https://www.reddit.com/svc/shreddit/search/?q=a", "https://www.reddit.com/svc/shreddit/search/?q=a&cursor=b")).toBe(false);
    expect(redirectedAway("https://www.reddit.com/svc/shreddit/search/?q=a", "https://www.reddit.com/login/?dest=x")).toBe(true);
  });
});
