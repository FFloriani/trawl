import { config } from "../config.ts";
import { getJson, TTL } from "../core/http.ts";
import type { Connector, SearchHit, SearchQuery } from "../core/types.ts";
import { isoDate, oneLine } from "../core/util.ts";

// Catalogs of agent tooling: the official MCP Registry (keyless) and SkillsMP (key).
// They answer "which MCP servers / skills exist for X" from the listing itself.

interface RegistryEntry {
  server: {
    name: string;
    title?: string;
    description?: string;
    version?: string;
    websiteUrl?: string;
    repository?: { url?: string };
    packages?: Array<{ registryType?: string; identifier?: string }>;
    remotes?: Array<{ type?: string; url?: string }>;
  };
  _meta?: Record<string, { status?: string; publishedAt?: string; updatedAt?: string; isLatest?: boolean }>;
}

async function registrySearch(term: string, signal?: AbortSignal): Promise<RegistryEntry[]> {
  const params = new URLSearchParams({ search: term, limit: "50" });
  const data = await getJson<{ servers?: RegistryEntry[] }>(`https://registry.modelcontextprotocol.io/v0/servers?${params}`, {
    cacheTtlMs: TTL.search,
    signal,
  });
  return data.servers ?? [];
}

export const mcpRegistry: Connector = {
  name: "mcp_registry",
  label: "MCP Registry oficial",
  async availability() {
    return { ok: true, mode: "API pública do registro oficial de servidores MCP, sem chave" };
  },
  async search(q: SearchQuery): Promise<SearchHit[]> {
    // The registry matches a substring of the server name, so a phrase rarely hits:
    // try the whole query, then each word from the longest.
    const words = q.query.split(/\s+/).filter((w) => w.length > 2 && !/^(mcp|server|servers|the|for|com|para)$/i.test(w));
    const terms = [q.query, ...words.sort((a, b) => b.length - a.length)];
    let entries: RegistryEntry[] = [];
    for (const term of [...new Set(terms)]) {
      entries = await registrySearch(term, q.signal);
      if (entries.length) break;
    }
    const cutoff = q.sinceDays ? Date.now() - q.sinceDays * 86_400_000 : 0;
    const out: SearchHit[] = [];
    const seen = new Set<string>();
    for (const e of entries) {
      const meta = e._meta?.["io.modelcontextprotocol.registry/official"];
      if (meta?.isLatest === false || meta?.status === "deleted" || seen.has(e.server.name)) continue;
      const updated = meta?.updatedAt ?? meta?.publishedAt;
      if (cutoff && updated && Date.parse(updated) < cutoff) continue;
      seen.add(e.server.name);
      const s = e.server;
      out.push({
        url: s.repository?.url || s.websiteUrl || `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(s.name)}`,
        title: s.title ? `${s.title} (${s.name})` : s.name,
        snippet: oneLine(s.description, 300),
        source: "mcp_registry",
        provider: "mcp-registry",
        published: isoDate(updated),
        tags: [
          s.version ? `v${s.version}` : "",
          ...(s.packages ?? []).map((p) => `${p.registryType}: ${p.identifier}`),
          s.remotes?.length ? "servidor remoto" : "",
        ].filter(Boolean),
      });
      if (out.length >= q.limit) break;
    }
    return out;
  },
};

interface SkillsmpSkill {
  name: string;
  author: string;
  description?: string;
  githubUrl?: string;
  skillUrl?: string;
  stars?: number;
  updatedAt?: number;
  contentLanguage?: string;
}

export const skillsmp: Connector = {
  name: "skillsmp",
  label: "SkillsMP (catálogo de skills)",
  async availability() {
    return config.keys.skillsmp
      ? { ok: true, mode: "API com chave (500 req/dia)" }
      : { ok: false, mode: "desligado", enable: "Defina SKILLSMP_API_KEY no .env da pasta de dados (trawl_doctor mostra onde) (chave em skillsmp.com)." };
  },
  async search(q: SearchQuery): Promise<SearchHit[]> {
    if (!config.keys.skillsmp) throw new Error("SkillsMP desligado: falta SKILLSMP_API_KEY");
    const params = new URLSearchParams({ q: q.query, limit: "50", sortBy: q.sinceDays ? "recent" : "stars" });
    const data = await getJson<{ data?: { skills?: SkillsmpSkill[] } }>(`https://skillsmp.com/api/v1/skills/search?${params}`, {
      headers: { authorization: `Bearer ${config.keys.skillsmp}` },
      cacheTtlMs: TTL.search,
      signal: q.signal,
    });
    const cutoff = q.sinceDays ? Date.now() - q.sinceDays * 86_400_000 : 0;
    const seen = new Set<string>();
    const out: SearchHit[] = [];
    for (const s of data.data?.skills ?? []) {
      // Translated copies of the same skill share author and name; keep one.
      const key = `${s.author}/${s.name}`;
      if (seen.has(key)) continue;
      if (cutoff && s.updatedAt && s.updatedAt * 1000 < cutoff) continue;
      seen.add(key);
      out.push({
        url: s.githubUrl || s.skillUrl || "https://skillsmp.com",
        title: `${s.name} (${s.author})`,
        snippet: oneLine(s.description, 300),
        source: "skillsmp",
        provider: "skillsmp",
        published: isoDate(s.updatedAt),
        metrics: { stars: s.stars },
        tags: ["estrelas são do repositório, não da skill", s.contentLanguage ?? ""].filter(Boolean),
      });
      if (out.length >= q.limit) break;
    }
    return out;
  },
};
