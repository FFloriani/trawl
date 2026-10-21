import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { config } from "../config.ts";
import { log } from "./log.ts";
import { errMessage, oneLine } from "./util.ts";

// The free web search is a SearXNG container, which only exists while Docker runs. After a
// reboot or a power cut Docker Desktop often stays closed, and web search silently goes away.
// When the configured SearXNG is local and down, Trawl brings it back by itself: it opens Docker
// Desktop if needed, then starts the container. Everything runs in the background, so a search
// never waits for it, and a lock file keeps parallel servers from opening Docker twice.
// TRAWL_SEARXNG_AUTOSTART=0 turns it off.

const execFileP = promisify(execFile);

const COMPOSE = fileURLToPath(new URL("../../docker/searxng/docker-compose.yml", import.meta.url));

/** How long a start attempt counts as "in progress" before another one may be made. */
export const COOLDOWN_MS = 7 * 60_000;
/** How long to wait for the Docker daemon after opening Docker Desktop. */
const BOOT_WAIT_MS = 5 * 60_000;

export type SearxngResult = { state: "up" } | { state: "starting"; note: string } | { state: "down"; reason: string };

/** Everything the start logic touches, so it can be tested without Docker. */
export interface SearxngEnv {
  healthy(): Promise<boolean>;
  docker(): Promise<"up" | "down" | "missing">;
  launchDesktop(): Promise<boolean>;
  composeUp(): Promise<{ ok: boolean; message: string }>;
  /** True when this call won the right to start it (nobody tried in the last COOLDOWN_MS). */
  claim(now: number): Promise<boolean>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export async function ensureSearxng(env: SearxngEnv): Promise<SearxngResult & { done?: Promise<void> }> {
  if (await env.healthy()) return { state: "up" };
  if (!(await env.claim(env.now()))) return { state: "starting", note: "já há uma tentativa de subir o SearXNG em andamento" };

  const docker = await env.docker();
  if (docker === "missing") return { state: "down", reason: "o Docker não está instalado (ou não está no PATH)" };
  if (docker === "up") {
    const r = await env.composeUp();
    return r.ok ? { state: "starting", note: r.message } : { state: "down", reason: r.message };
  }

  if (!(await env.launchDesktop())) return { state: "down", reason: "o Docker está parado e não consegui abrir o Docker Desktop; abra-o à mão" };
  // The daemon needs a while after the app opens; the container is started once it answers.
  const done = (async () => {
    const until = env.now() + BOOT_WAIT_MS;
    while (env.now() < until) {
      await env.sleep(3000);
      if ((await env.docker()) !== "up") continue;
      const r = await env.composeUp();
      if (!r.ok) log.warn("searxng autostart", r.message);
      return;
    }
    log.warn("searxng autostart", "o Docker Desktop não ficou pronto a tempo");
  })();
  return { state: "starting", note: "abri o Docker Desktop; o SearXNG volta em 1 a 3 min", done };
}

/** Whether a URL points at this machine (only then is it ours to start). */
export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** GET /healthz with the timer and body cleaned up at once: a pending abort at exit trips a libuv assertion on Windows. */
export async function searxngHealthy(base: string): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 3000);
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/healthz`, { signal: ctl.signal });
    await res.arrayBuffer().catch(() => undefined);
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function detach(cmd: string, args: string[]): boolean {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function searxngEnv(base: string): SearxngEnv {
  const lock = join(config.home, "searxng-start.json");
  return {
    healthy: () => searxngHealthy(base),
    async docker() {
      try {
        await execFileP("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 12_000, windowsHide: true });
        return "up";
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "down";
      }
    },
    async launchDesktop() {
      if (process.platform === "win32") {
        const exe = [
          join(process.env.LOCALAPPDATA ?? "", "Programs", "DockerDesktop", "Docker Desktop.exe"),
          join(process.env.ProgramFiles ?? "C:\\Program Files", "Docker", "Docker", "Docker Desktop.exe"),
        ].find((p) => existsSync(p));
        // -Autostart is what Docker's own login entry passes: it starts in the tray, without the dashboard window.
        return exe ? detach(exe, ["-Autostart"]) : false;
      }
      if (process.platform === "darwin") return detach("open", ["-ga", "Docker"]);
      return false;
    },
    async composeUp() {
      const dir = dirname(COMPOSE);
      if (!existsSync(COMPOSE)) return { ok: false, message: "docker/searxng não encontrado ao lado do servidor" };
      if (!existsSync(join(dir, ".env"))) return { ok: false, message: "falta o segredo do SearXNG: rode `npm run searxng` uma vez na pasta do Trawl" };
      try {
        await execFileP("docker", ["compose", "-f", COMPOSE, "up", "-d"], { timeout: 180_000, windowsHide: true, cwd: dir });
        return { ok: true, message: "container do SearXNG iniciado" };
      } catch (err) {
        return { ok: false, message: `docker compose falhou: ${oneLine(errMessage(err), 160)}` };
      }
    },
    async claim(now) {
      const payload = JSON.stringify({ at: now, pid: process.pid });
      try {
        await mkdir(config.home, { recursive: true });
        await writeFile(lock, payload, { flag: "wx" });
        return true;
      } catch (err) {
        // Cannot write the lock at all: trying is better than staying down.
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") return true;
      }
      let at = 0;
      try {
        at = Number((JSON.parse(await readFile(lock, "utf8")) as { at?: number }).at ?? 0);
      } catch {
        // a torn or empty lock counts as stale
      }
      if (now - at < COOLDOWN_MS) return false;
      await writeFile(lock, payload).catch(() => undefined);
      return true;
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

let last: SearxngResult | undefined;

/** What the last attempt in this process found, for the notes that explain a missing web search. */
export function lastSearxngResult(): SearxngResult | undefined {
  return last;
}

/** Whether Trawl may start the configured SearXNG by itself. */
export function searxngAutostartOn(): boolean {
  const url = config.keys.searxngUrl;
  return Boolean(url) && config.searxngAutostart && isLocalUrl(url!);
}

let serving = false;

/**
 * Called by the long-lived MCP server. Only there may SearXNG be brought back: a one-shot command
 * (doctor, search, read, radar) exits before the background start could finish.
 */
export function markServerProcess(): void {
  serving = true;
}

/**
 * Brings the local SearXNG back if it is down. Meant to be called when an agent actually needs
 * web search, never when the server merely starts: Docker is heavy and stays closed otherwise.
 * Safe to call often: it returns at once when the server answers, and the lock keeps attempts
 * apart. Never throws.
 */
export function kickSearxng(): Promise<SearxngResult | undefined> {
  if (!serving || !searxngAutostartOn()) return Promise.resolve(undefined);
  return ensureSearxng(searxngEnv(config.keys.searxngUrl!)).then(
    (r) => (last = r),
    (err) => {
      log.warn("searxng autostart", errMessage(err));
      return undefined;
    },
  );
}
