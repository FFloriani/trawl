import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config.ts";
import { cache } from "./cache.ts";
import { log } from "./log.ts";

// Pages that build their text with JavaScript (official game sites, many SPAs) come back empty
// from a plain fetch. For those, an installed Chrome or Edge renders the page headless and
// prints the final DOM (--dump-dom). Rules:
//  - a fresh, empty profile every time: never the user's cookies, logins or extensions;
//  - only for pages that loaded fine (HTTP 200) but had almost no text. A page that blocks
//    robots (403/429, "checking your browser", CAPTCHA) is left alone: passing a bot check is
//    not something this tool does.

const CANDIDATES: Record<string, string[]> = {
  win32: [
    join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env["LOCALAPPDATA"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"],
};

let detected: string | null | undefined;

/** Chrome/Edge to render with: TRAWL_BROWSER (a path, or "off"), else the first one installed. */
export function browserPath(): string | undefined {
  const forced = config.browser;
  if (forced?.toLowerCase() === "off") return undefined;
  if (forced) return existsSync(forced) ? forced : undefined;
  if (detected === undefined) detected = (CANDIDATES[process.platform] ?? []).find((p) => p && existsSync(p)) ?? null;
  return detected ?? undefined;
}

const CHALLENGE = /just a moment|checking your browser|verify you are human|are you a robot|enable javascript and cookies|captcha|cf-challenge|attention required/i;

/** True when the rendered page is a bot check rather than content; such pages are discarded. */
export function looksLikeChallenge(html: string): boolean {
  const head = html.slice(0, 20_000);
  return CHALLENGE.test(head) && html.length < 60_000;
}

// At most two browsers at a time: each render is a full Chrome process.
let running = 0;
const queue: Array<() => void> = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>((r) => queue.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    queue.shift()?.();
  }
}

const FLAGS = [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-sync",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-default-apps",
  "--no-pings",
  "--mute-audio",
  "--hide-scrollbars",
  // Lets the page's scripts run (fetch the text, build the DOM) before the DOM is printed.
  "--virtual-time-budget=8000",
  "--dump-dom",
];

/** Final DOM of a page after its JavaScript ran, from a headless browser with an empty profile. */
export async function renderHtml(url: string, timeoutMs = 30_000): Promise<string> {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("só http(s)");
  const exe = browserPath();
  if (!exe) throw new Error("nenhum Chrome/Edge encontrado (defina TRAWL_BROWSER com o caminho)");
  const key = `render ${u.toString()}`;
  const hit = await cache.get<string>(key, 24 * 3600_000);
  if (hit) return hit;
  const html = await slot(
    () =>
      new Promise<string>((resolve, reject) => {
        const profile = mkdtempSync(join(tmpdir(), "ss-browser-"));
        execFile(
          exe,
          [...FLAGS, `--user-data-dir=${profile}`, u.toString()],
          { timeout: timeoutMs, maxBuffer: 30 * 1024 * 1024, windowsHide: true },
          (err, stdout) => {
            // Chrome may still hold the profile for a moment after exiting.
            setTimeout(() => rmSync(profile, { recursive: true, force: true, maxRetries: 3 }), 1000).unref();
            if (err && !stdout) return reject(new Error(`navegador falhou: ${err.message.split("\n")[0]}`));
            resolve(stdout);
          },
        );
      }),
  );
  if (!html.trim()) throw new Error("navegador não devolveu conteúdo");
  if (looksLikeChallenge(html)) throw new Error("a página pediu verificação anti-robô; não é contornada");
  await cache.set(key, html).catch((e: unknown) => log.debug("render cache", e));
  return html;
}
