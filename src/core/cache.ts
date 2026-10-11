import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.ts";

interface Entry<T> {
  at: number;
  value: T;
}

/** On-disk TTL cache: saves API quota and makes re-runs of the same research fast. */
export class DiskCache {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  private pathFor(key: string): string {
    const h = createHash("sha1").update(key).digest("hex");
    return join(this.dir, h.slice(0, 2), h + ".json");
  }

  async get<T>(key: string, ttlMs: number): Promise<T | undefined> {
    try {
      const entry = JSON.parse(await readFile(this.pathFor(key), "utf8")) as Entry<T>;
      return Date.now() - entry.at <= ttlMs ? entry.value : undefined;
    } catch {
      return undefined;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    const file = this.pathFor(key);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(tmp, JSON.stringify({ at: Date.now(), value } satisfies Entry<T>));
      await rename(tmp, file);
    } catch {
      // A failed cache write only costs a refetch later.
    }
  }
}

export const cache = new DiskCache(config.cacheDir);
