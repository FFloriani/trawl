import { getJson, TTL } from "../core/http.ts";
import type { ReadResult } from "../core/types.ts";
import { decodeEntities, isoDate } from "../core/util.ts";

// A game's announcements on Steam are posted by its developer or publisher, so they are an
// official source even when the game's own site only renders with JavaScript. The public news
// API mixes in press articles; only the "steam_community_announcements" feed is kept.

interface NewsItem {
  gid?: string;
  title: string;
  url: string;
  author?: string;
  contents?: string;
  date?: number;
  feedname?: string;
  feedlabel?: string;
}

/** The Steam app id in a news URL: the API (appid=) or the store news page (/news/app/<id>). */
export function steamNewsAppId(url: URL): string | undefined {
  if (url.hostname === "api.steampowered.com" && /\/ISteamNews\/GetNewsForApp\//i.test(url.pathname)) {
    const id = url.searchParams.get("appid");
    return id && /^\d+$/.test(id) ? id : undefined;
  }
  if (url.hostname === "store.steampowered.com") return /^\/news\/app\/(\d+)/.exec(url.pathname)?.[1];
  return undefined;
}

/** The single announcement a store link points to (/news/app/<id>/view/<gid>), if any. */
export function steamNewsPostId(url: URL): string | undefined {
  return url.hostname === "store.steampowered.com" ? /^\/news\/app\/\d+\/view\/(\d+)/.exec(url.pathname)?.[1] : undefined;
}

/** Steam's announcement markup (BBCode, sometimes HTML) as plain Markdown. */
export function steamMarkup(text: string): string {
  return decodeEntities(
    text
      .replace(/\[img[^\]]*\][\s\S]*?\[\/img\]/gi, "")
      .replace(/\[previewyoutube[^\]]*\][\s\S]*?\[\/previewyoutube\]/gi, "")
      .replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, "[$2]($1)")
      .replace(/\[h[1-3]\]([\s\S]*?)\[\/h[1-3]\]/gi, "\n\n### $1\n\n")
      .replace(/\[\/?b\]/gi, "**")
      .replace(/\[\/?i\]/gi, "_")
      .replace(/\[\*\]/g, "\n- ")
      .replace(/\[\/?(?:p|list|olist|u|strike|quote|code|table|tr|td|th|hr|spoiler|noparse)[^\]]*\]/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|li|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function readSteamNews(appid: string, count = 15, postId?: string): Promise<ReadResult> {
  // A single post is looked up among the latest 100 announcements.
  const params = new URLSearchParams({ appid, count: String(postId ? 100 : count), maxlength: "0", feeds: "steam_community_announcements", format: "json" });
  const data = await getJson<{ appnews?: { newsitems?: NewsItem[] } }>(`https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?${params}`, {
    cacheTtlMs: TTL.social,
  });
  const items = (data.appnews?.newsitems ?? []).filter((n) => !n.feedname || n.feedname === "steam_community_announcements");
  if (!items.length) throw new Error(`o app ${appid} não tem anúncios oficiais na Steam`);
  if (postId) {
    const n = items.find((x) => x.gid === postId);
    if (!n) throw new Error(`anúncio ${postId} não está entre os 100 mais recentes do app ${appid}`);
    return {
      url: `https://store.steampowered.com/news/app/${appid}/view/${postId}`,
      title: n.title,
      source: "page",
      published: isoDate(n.date),
      author: n.author,
      note: "Anúncio oficial do desenvolvedor na Steam.",
      content: [`${isoDate(n.date)?.slice(0, 10) ?? ""}${n.author ? ` · ${n.author}` : ""}`, "", steamMarkup(n.contents ?? "")].join("\n"),
    };
  }
  return {
    url: `https://store.steampowered.com/news/app/${appid}`,
    title: `Anúncios oficiais na Steam (app ${appid})`,
    source: "page",
    published: isoDate(items[0]!.date),
    note: "Só os anúncios publicados pelo desenvolvedor na Steam (feed oficial), sem matérias de imprensa.",
    content: items
      .map((n) => [`## ${n.title}`, `${isoDate(n.date)?.slice(0, 10) ?? ""}${n.author ? ` · ${n.author}` : ""} · ${n.url}`, "", steamMarkup(n.contents ?? "")].join("\n"))
      .join("\n\n"),
  };
}
