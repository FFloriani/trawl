import { browserPath, renderHtml } from "../core/browser.ts";
import { htmlToMarkdown } from "../core/extract.ts";
import { request, TTL } from "../core/http.ts";
import type { ReadResult } from "../core/types.ts";
import { isoDate } from "../core/util.ts";
import { arxivIdFromUrl, readArxiv } from "./arxiv.ts";
import { isForumTopic, readForumTopic } from "./forums.ts";
import { readGithubDiscussion, readGithubIssue, readGithubRepo } from "./github.ts";
import { readHnItem } from "./hackernews.ts";
import { readRedditThread, redditThreadId } from "./reddit.ts";
import { readSteamNews, steamNewsAppId, steamNewsPostId } from "./steam.ts";
import { readXPost } from "./x.ts";
import { readYoutube, youtubeId } from "./youtube.ts";

const GITHUB_RESERVED = new Set(["orgs", "settings", "marketplace", "topics", "search", "sponsors", "features", "collections", "trending", "apps"]);

/** Picks the richest reader for a URL: APIs for known platforms, Readability for the rest. */
export async function readUrl(url: string): Promise<ReadResult> {
  const u = new URL(url);
  const host = u.hostname.replace(/^(www|old|new|np|m)\./, "");

  if (host === "reddit.com" && redditThreadId(url)) return readRedditThread(url);

  if (host === "news.ycombinator.com" && u.searchParams.get("id")) return readHnItem(u.searchParams.get("id")!);

  if (host === "github.com") {
    const [owner, repo, kind, num] = u.pathname.split("/").filter(Boolean);
    if (owner && repo && !GITHUB_RESERVED.has(owner)) {
      if ((kind === "issues" || kind === "pull") && num && /^\d+$/.test(num)) return readGithubIssue(owner, repo, num);
      if (kind === "discussions" && num && /^\d+$/.test(num)) return readGithubDiscussion(owner, repo, num);
      if (!kind || kind === "tree") return readGithubRepo(owner, repo);
    }
  }

  if (host === "arxiv.org" || host === "export.arxiv.org") {
    const id = arxivIdFromUrl(url);
    if (id) return readArxiv(id);
  }

  if ((host === "x.com" || host === "twitter.com") && /\/status\/\d+/.test(u.pathname)) return readXPost(url);

  if (host === "youtube.com" || host === "youtu.be") {
    const id = youtubeId(u);
    if (id) return readYoutube(id);
  }

  if (isForumTopic(u)) return readForumTopic(u);

  const steamApp = steamNewsAppId(u);
  if (steamApp) {
    const post = steamNewsPostId(u);
    // An old single post may be beyond the API window: then the store page itself is read.
    if (post) return readSteamNews(steamApp, 15, post).catch(() => readPage(url));
    return readSteamNews(steamApp);
  }

  return readPage(url);
}

async function readPage(url: string): Promise<ReadResult> {
  const res = await request(url, { browser: true, cacheTtlMs: TTL.page, timeoutMs: 30_000 });
  const type = res.headers["content-type"] ?? "";
  if (type.includes("pdf") || res.text.startsWith("%PDF")) {
    throw new Error("PDF ainda não é suportado pelo trawl_read. Procure a versão HTML (ex.: arxiv.org/html/<id>) ou o resumo.");
  }
  if (type.includes("html") || /^\s*<(!doctype|html)/i.test(res.text)) {
    let page = htmlToMarkdown(res.text, res.url);
    let rendered = "";
    // The page loaded but its text is built by JavaScript: render it in a headless browser.
    if (page.markdown.length < 400 && browserPath()) {
      try {
        const html = await renderHtml(res.url);
        const again = htmlToMarkdown(html, res.url);
        if (again.markdown.length > page.markdown.length + 200) {
          page = again;
          rendered = "Página montada por JavaScript: lida com navegador sem interface e perfil vazio.";
        }
      } catch (err) {
        rendered = `Tentativa com navegador falhou: ${err instanceof Error ? err.message : String(err)}.`;
      }
    }
    const thin = page.markdown.length < 400;
    return {
      url: res.url,
      title: page.title,
      source: "page",
      published: isoDate(page.published),
      author: page.byline,
      content: page.markdown,
      note: [
        res.truncated ? "Página muito grande: lida só a parte inicial." : "",
        rendered,
        thin ? "Pouco texto extraído: a página pode exigir login ou bloquear leitura automática." : "",
      ]
        .filter(Boolean)
        .join(" ") || undefined,
    };
  }
  return { url: res.url, title: textTitle(res.text) ?? url, source: "page", content: res.text, note: res.truncated ? "Conteúdo truncado." : undefined };
}

/** Title of a Markdown/text page: front-matter `title:` or the first `# ` heading. */
export function textTitle(text: string): string | undefined {
  const front = /^---\s*\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m.exec(text.slice(0, 2000));
  if (front?.[1]) return front[1].trim();
  return /^#\s+(.+)$/m.exec(text.slice(0, 4000))?.[1]?.trim();
}
