import type { Availability, Connector, SearchHit, SearchQuery } from "../core/types.ts";
import { errMessage, isoDate, mapLimit, oneLine } from "../core/util.ts";
import { pullpushComments } from "./pullpush.ts";
import { originalComment, splitSubreddit } from "./reddit.ts";
import { hasSession } from "./reddit-session.ts";
import { shredditCommentSearch, type ShredditCommentHit } from "./shreddit.ts";

// Search inside Reddit comments: where people say what they actually did. With the user's
// session, Reddit's own site search finds the comments (live votes) and the JSON of each thread
// gives the original text; the site shows a machine translation to the account's language, which
// is never what a research should quote. Without a session, the PullPush archive is the only way.

function toHit(c: ShredditCommentHit, original?: { body: string; author?: string; score?: number; created?: number }): SearchHit | undefined {
  const text = (original?.body ?? c.shownText).trim();
  if (!text || text === "[removed]" || text === "[deleted]") return undefined;
  const author = original?.author ?? c.author;
  if (author === "AutoModerator") return undefined;
  return {
    url: c.url,
    title: oneLine(text, 140),
    snippet: oneLine(text, 500),
    source: "reddit_comments",
    provider: original ? "reddit-sessao" : "reddit-web",
    published: isoDate(original?.created ?? c.created),
    author,
    metrics: { score: original?.score ?? c.score },
    tags: [
      c.subreddit ? `r/${c.subreddit}` : "",
      "comentário",
      c.postTitle ? `na conversa: ${oneLine(c.postTitle, 80)}` : "",
      original ? "" : "texto traduzido pelo Reddit (o original vem no trawl_read da conversa)",
    ].filter(Boolean),
  };
}

export const redditComments: Connector = {
  name: "reddit_comments",
  label: "Reddit (comentários)",
  async availability(): Promise<Availability> {
    if (hasSession()) {
      return {
        ok: true,
        mode: "busca nos comentários pelo próprio site do Reddit (sessão logada), com votos atuais e o texto original de cada comentário; reserva no arquivo PullPush",
      };
    }
    return {
      ok: true,
      mode: "busca em comentários pelo arquivo PullPush, sem chave (às vezes fora do ar)",
      enable: "Com a sua sessão do Reddit (REDDIT_COOKIE no .env da pasta de dados) a busca usa o próprio site do Reddit e não depende do PullPush.",
    };
  },
  async search(q: SearchQuery): Promise<SearchHit[]> {
    const errors: string[] = [];
    if (hasSession()) {
      try {
        const { subreddit, rest } = splitSubreddit(q.query);
        const found = await shredditCommentSearch(subreddit ? rest || subreddit : q.query, { subreddit, sinceDays: q.sinceDays, limit: q.limit, signal: q.signal });
        // Two at a time: one small JSON per comment, so the original text is what gets ranked and quoted.
        const hits = await mapLimit(found, 2, async (c) => toHit(c, await originalComment(c.postId, c.id, q.signal).catch(() => undefined)));
        return hits.filter((h): h is SearchHit => Boolean(h));
      } catch (err) {
        errors.push(`site: ${errMessage(err)}`);
      }
    }
    try {
      return await pullpushComments(q);
    } catch (err) {
      errors.push(`pullpush: ${errMessage(err)}`);
    }
    throw new Error(errors.join(" | "));
  },
};
