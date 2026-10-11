import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { oneLine } from "./util.ts";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "_",
});
turndown.remove(["script", "style", "noscript", "iframe", "canvas", "form", "button"]);
turndown.remove((node) => node.nodeName.toLowerCase() === "svg");

export interface Extracted {
  title: string;
  byline?: string;
  published?: string;
  markdown: string;
}

function meta(document: Document, ...names: string[]): string | undefined {
  for (const n of names) {
    const el = document.querySelector(`meta[property="${n}"], meta[name="${n}"], meta[itemprop="${n}"]`);
    const v = el?.getAttribute("content")?.trim();
    if (v) return v;
  }
  return undefined;
}

/** HTML page → readable Markdown (Readability first, whole body as a fallback). */
export function htmlToMarkdown(html: string, url: string): Extracted {
  const { document } = parseHTML(html);
  const title =
    meta(document as unknown as Document, "og:title", "twitter:title") ??
    oneLine(document.querySelector("title")?.textContent ?? "", 200);
  const published = meta(
    document as unknown as Document,
    "article:published_time",
    "datePublished",
    "pubdate",
    "date",
    "og:updated_time",
  );

  let contentHtml: string | undefined;
  let byline: string | undefined;
  try {
    // Readability mutates the DOM, so it gets its own copy.
    const { document: copy } = parseHTML(html);
    const article = new Readability(copy as unknown as Document, { charThreshold: 300 }).parse();
    if (article?.content && (article.textContent?.trim().length ?? 0) > 200) {
      contentHtml = article.content;
      byline = article.byline ?? undefined;
    }
  } catch {
    // fall through to body
  }
  if (!contentHtml) {
    for (const sel of ["script", "style", "nav", "header", "footer", "aside", "noscript"]) {
      for (const el of document.querySelectorAll(sel)) el.remove();
    }
    contentHtml = document.querySelector("main")?.innerHTML ?? document.body?.innerHTML ?? "";
  }

  let markdown = turndown.turndown(contentHtml);
  markdown = absolutizeLinks(markdown, url)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title: title || url, byline, published, markdown };
}

function absolutizeLinks(md: string, base: string): string {
  return md.replace(/\]\((\/[^)\s]*)\)/g, (m, path: string) => {
    try {
      return `](${new URL(path, base).toString()})`;
    } catch {
      return m;
    }
  });
}
