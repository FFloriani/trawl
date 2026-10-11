/** Every searchable place. "layers" in the research plan map onto these. */
export const SOURCE_NAMES = [
  "web",
  "reddit",
  "reddit_comments",
  "hn",
  "x",
  "github",
  "github_issues",
  "github_code",
  "github_discussions",
  "arxiv",
  "openalex",
  "stackexchange",
  "wikipedia",
  "forums",
  "youtube",
  "mcp_registry",
  "skillsmp",
] as const;

export type SourceName = (typeof SOURCE_NAMES)[number];

export interface Metrics {
  score?: number;
  comments?: number;
  stars?: number;
  forks?: number;
  likes?: number;
  reposts?: number;
  replies?: number;
  views?: number;
  answers?: number;
  citations?: number;
}

export interface SearchHit {
  url: string;
  title: string;
  snippet?: string;
  source: SourceName;
  provider: string;
  published?: string;
  author?: string;
  metrics?: Metrics;
  /** Short facts that help judge the hit: subreddit, language, venue, license… */
  tags?: string[];
}

export interface SearchQuery {
  query: string;
  limit: number;
  sinceDays?: number;
  signal?: AbortSignal;
}

export interface Availability {
  ok: boolean;
  mode: string;
  note?: string;
  enable?: string;
}

export interface Connector {
  name: SourceName;
  label: string;
  availability(): Promise<Availability>;
  search(q: SearchQuery): Promise<SearchHit[]>;
}

export interface ReadResult {
  url: string;
  title: string;
  source: SourceName | "page";
  published?: string;
  author?: string;
  metrics?: Metrics;
  /** Markdown body. */
  content: string;
  note?: string;
}
