// Sobe o SearXNG local (docker/searxng), espera ficar pronto, testa uma busca em JSON e
// grava SEARXNG_URL no ~/.trawl/.env. Uso: npm run searxng | npm run searxng -- stop
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "docker", "searxng");
const compose = ["compose", "-f", join(dir, "docker-compose.yml")];
const url = "http://127.0.0.1:8888";

if (process.argv[2] === "stop") {
  execFileSync("docker", [...compose, "down"], { stdio: "inherit" });
  process.exit(0);
}

// The secret signs SearXNG's own tokens; it is created once and stays on this machine.
const envFile = join(dir, ".env");
if (!existsSync(envFile)) writeFileSync(envFile, `SEARXNG_SECRET=${randomBytes(32).toString("hex")}\n`);

execFileSync("docker", [...compose, "up", "-d"], { stdio: "inherit" });

let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  try {
    ready = (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    // still starting
  }
  if (!ready) await new Promise((r) => setTimeout(r, 1000));
}
if (!ready) {
  console.error(`SearXNG não respondeu em ${url} depois de 60 s. Veja: docker logs trawl-searxng`);
  process.exit(1);
}

const res = await fetch(`${url}/search?q=model+context+protocol&format=json`, { signal: AbortSignal.timeout(20000) });
const data = res.ok ? await res.json() : undefined;
const count = data?.results?.length ?? 0;
console.log(`SearXNG pronto em ${url}: busca de teste trouxe ${count} resultados${res.ok ? "" : ` (HTTP ${res.status})`}.`);

// Same rule as the server: TRAWL_HOME (or SS_HOME), else ~/.trawl, or an existing ~/.supersearch.
const legacy = join(homedir(), ".supersearch");
const fresh = join(homedir(), ".trawl");
const home = process.env.TRAWL_HOME ?? process.env.SS_HOME ?? (!existsSync(fresh) && existsSync(legacy) ? legacy : fresh);
const userEnv = join(home, ".env");
mkdirSync(home, { recursive: true });
const current = existsSync(userEnv) ? readFileSync(userEnv, "utf8") : "";
if (!/^\s*SEARXNG_URL\s*=/m.test(current)) {
  appendFileSync(userEnv, `${current && !current.endsWith("\n") ? "\n" : ""}SEARXNG_URL=${url}\n`);
  console.log(`SEARXNG_URL=${url} gravado em ${userEnv}.`);
} else {
  console.log(`SEARXNG_URL já está em ${userEnv}.`);
}
