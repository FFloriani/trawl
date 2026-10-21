import { describe, expect, it, vi } from "vitest";
import { COOLDOWN_MS, ensureSearxng, isLocalUrl, kickSearxng, searxngEnv, type SearxngEnv } from "../src/core/searxng.ts";

/** Loads the module fresh with the given environment, since the settings are read at import. */
async function withEnv(vars: Record<string, string | undefined>) {
  vi.resetModules();
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await import("../src/core/searxng.ts");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** A fake machine: `daemon` answers in order (the last answer repeats), time moves only when someone sleeps. */
function machine(daemon: Array<"up" | "down" | "missing">, over: Partial<SearxngEnv> = {}) {
  let t = 1_000_000;
  const calls: string[] = [];
  const answers = [...daemon];
  const env: SearxngEnv = {
    healthy: async () => false,
    docker: async () => {
      calls.push("docker");
      return answers.length > 1 ? answers.shift()! : answers[0]!;
    },
    launchDesktop: async () => {
      calls.push("launch");
      return true;
    },
    composeUp: async () => {
      calls.push("compose");
      return { ok: true, message: "container do SearXNG iniciado" };
    },
    claim: async () => {
      calls.push("claim");
      return true;
    },
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    ...over,
  };
  return { env, calls };
}

describe("SearXNG autostart", () => {
  it("does nothing when it already answers", async () => {
    const { env, calls } = machine(["down"], { healthy: async () => true });
    expect(await ensureSearxng(env)).toEqual({ state: "up" });
    expect(calls).toEqual([]);
  });

  it("opens Docker Desktop when the daemon is down, then starts the container once the daemon answers", async () => {
    const { env, calls } = machine(["down", "down", "up"]);
    const r = await ensureSearxng(env);
    expect(r.state).toBe("starting");
    await r.done;
    expect(calls).toEqual(["claim", "docker", "launch", "docker", "docker", "compose"]);
  });

  it("starts only the container when Docker is up but the container is gone", async () => {
    const { env, calls } = machine(["up"]);
    const r = await ensureSearxng(env);
    expect(r).toMatchObject({ state: "starting", note: "container do SearXNG iniciado" });
    expect(calls).toEqual(["claim", "docker", "compose"]);
  });

  it("explains the failure instead of looping when Docker is not installed or cannot be opened", async () => {
    const missing = machine(["missing"]);
    expect(await ensureSearxng(missing.env)).toMatchObject({ state: "down", reason: expect.stringContaining("não está instalado") });
    expect(missing.calls).not.toContain("launch");

    const stuck = machine(["down"], { launchDesktop: async () => false });
    expect(await ensureSearxng(stuck.env)).toMatchObject({ state: "down", reason: expect.stringContaining("abra-o à mão") });

    const broken = machine(["up"], { composeUp: async () => ({ ok: false, message: "falta o segredo do SearXNG" }) });
    expect(await ensureSearxng(broken.env)).toEqual({ state: "down", reason: "falta o segredo do SearXNG" });
  });

  it("does not try again while another attempt is in progress", async () => {
    const { env, calls } = machine(["down"], { claim: async () => false });
    expect(await ensureSearxng(env)).toMatchObject({ state: "starting" });
    expect(calls).toEqual([]);
  });

  it("gives up quietly when the daemon never comes up", async () => {
    const { env, calls } = machine(["down"]);
    const r = await ensureSearxng(env);
    await r.done;
    expect(calls).not.toContain("compose");
    expect(calls.filter((c) => c === "docker").length).toBeGreaterThan(10);
  });

  it("recognizes only this machine's addresses as its own to start", () => {
    expect(isLocalUrl("http://127.0.0.1:8888")).toBe(true);
    expect(isLocalUrl("http://localhost:8888/")).toBe(true);
    expect(isLocalUrl("http://[::1]:8888")).toBe(true);
    expect(isLocalUrl("https://search.example.com")).toBe(false);
    expect(isLocalUrl("not a url")).toBe(false);
  });

  it("leaves a start attempt alone for the cooldown, then lets another take over", async () => {
    const env = searxngEnv("http://127.0.0.1:1");
    const now = Date.now();
    expect(await env.claim(now)).toBe(true);
    expect(await env.claim(now + 1000)).toBe(false);
    expect(await env.claim(now + COOLDOWN_MS + 1000)).toBe(true);
  });

  it("stays out of the way when no local SearXNG is configured", async () => {
    expect(await kickSearxng()).toBeUndefined();
  });

  it("never opens Docker unless the user turned it on", async () => {
    const local = "http://127.0.0.1:8888";
    expect((await withEnv({ SEARXNG_URL: local, TRAWL_SEARXNG_AUTOSTART: undefined })).searxngAutostartOn()).toBe(false);
    expect((await withEnv({ SEARXNG_URL: local, TRAWL_SEARXNG_AUTOSTART: "0" })).searxngAutostartOn()).toBe(false);
    expect((await withEnv({ SEARXNG_URL: local, TRAWL_SEARXNG_AUTOSTART: "1" })).searxngAutostartOn()).toBe(true);
    // Even when on, only a SearXNG on this machine is ours to start.
    expect((await withEnv({ SEARXNG_URL: "https://search.example.com", TRAWL_SEARXNG_AUTOSTART: "1" })).searxngAutostartOn()).toBe(false);
    // And with the default, kicking does nothing at all.
    const off = await withEnv({ SEARXNG_URL: local, TRAWL_SEARXNG_AUTOSTART: undefined });
    off.markServerProcess();
    expect(await off.kickSearxng()).toBeUndefined();
  });

  it("starts nothing outside the MCP server process, even when turned on", async () => {
    // A one-shot command (doctor, search) would exit before the background start finished.
    const cli = await withEnv({ SEARXNG_URL: "http://127.0.0.1:8888", TRAWL_SEARXNG_AUTOSTART: "1" });
    expect(cli.searxngAutostartOn()).toBe(true);
    expect(await cli.kickSearxng()).toBeUndefined();
  });
});
