import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { log } from "./core/log.ts";

export const VERSION = "0.1.0";

const NEW_HOME = join(homedir(), ".trawl");
const LEGACY_HOME = join(homedir(), ".supersearch");

/**
 * Home of cache, research sessions and the optional .env with API keys: TRAWL_HOME (or the older
 * SS_HOME), else ~/.trawl. A ~/.supersearch from before the rename keeps being used, so nothing
 * has to move.
 */
export const TRAWL_HOME =
  process.env.TRAWL_HOME ?? process.env.SS_HOME ?? (!existsSync(NEW_HOME) && existsSync(LEGACY_HOME) ? LEGACY_HOME : NEW_HOME);

// Keys can live in the home's .env so IDE configs never carry secrets.
// Variables already set in the environment win over the file.
function loadHomeEnv(): void {
  const file = join(TRAWL_HOME, ".env");
  if (!existsSync(file)) return;
  try {
    const parsed = parseEnv(readFileSync(file, "utf8"));
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined && v !== undefined) process.env[k] = v;
    }
  } catch (err) {
    log.warn(`could not parse ${file}`, err);
  }
}
loadHomeEnv();

/** TRAWL_X settings also accept their old SS_X name. */
const env = (name: string): string | undefined => {
  const v = (process.env[name] ?? (name.startsWith("TRAWL_") ? process.env[`SS_${name.slice(6)}`] : undefined))?.trim();
  return v ? v : undefined;
};

export const config = {
  home: TRAWL_HOME,
  cacheDir: join(TRAWL_HOME, "cache"),
  researchDir: env("TRAWL_RESEARCH_DIR") ?? join(TRAWL_HOME, "research"),
  contactEmail: env("TRAWL_CONTACT_EMAIL"),
  keys: {
    brave: env("BRAVE_API_KEY"),
    tavily: env("TAVILY_API_KEY"),
    exa: env("EXA_API_KEY"),
    searxngUrl: env("SEARXNG_URL"),
    redditClientId: env("REDDIT_CLIENT_ID"),
    redditClientSecret: env("REDDIT_CLIENT_SECRET"),
    /** Cookie header of the user's own logged-in Reddit session (opt-in). */
    redditCookie: env("REDDIT_COOKIE"),
    xai: env("XAI_API_KEY"),
    xBearer: env("X_BEARER_TOKEN"),
    twitterapiIo: env("TWITTERAPI_IO_KEY"),
    stackexchange: env("STACKEXCHANGE_KEY"),
    openalex: env("OPENALEX_API_KEY"),
    skillsmp: env("SKILLSMP_API_KEY"),
  },
  /** Discourse forums always searched by the "forums" source; each research can add its own. */
  forums: (env("TRAWL_FORUMS") ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean),
  xaiModel: env("XAI_MODEL") ?? "grok-4.7",
  /** Comma list that orders the web providers, e.g. "searxng,brave,tavily,exa". */
  webProviders: (env("TRAWL_WEB_PROVIDERS") ?? "searxng,brave,tavily,exa")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  wikipediaLang: env("TRAWL_WIKIPEDIA_LANG") ?? "en",
  /** Chrome/Edge used to read pages built by JavaScript: a path, "off", or unset to auto-detect. */
  browser: env("TRAWL_BROWSER"),
};

export function userAgent(): string {
  const contact = config.contactEmail ? `; ${config.contactEmail}` : "";
  return `Trawl/${VERSION} (research MCP server${contact})`;
}

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

let ghTokenPromise: Promise<string | undefined> | undefined;

/** GITHUB_TOKEN / GH_TOKEN, else the token of a logged-in `gh` CLI. */
export function githubToken(): Promise<string | undefined> {
  const fromEnv = env("GITHUB_TOKEN") ?? env("GH_TOKEN");
  if (fromEnv) return Promise.resolve(fromEnv);
  ghTokenPromise ??= new Promise((resolve) => {
    execFile("gh", ["auth", "token"], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      const token = stdout?.trim();
      resolve(!err && token ? token : undefined);
    });
  });
  return ghTokenPromise;
}
