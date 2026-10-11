// stdout is reserved for the MCP protocol, so every log line goes to stderr.
type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[((process.env.TRAWL_LOG ?? process.env.SS_LOG) as Level) ?? "info"] ?? order.info;

function write(level: Level, msg: string, extra?: unknown): void {
  if (order[level] < threshold) return;
  const line = `[ss ${level}] ${msg}`;
  if (extra === undefined) console.error(line);
  else console.error(line, extra);
}

export const log = {
  debug: (msg: string, extra?: unknown) => write("debug", msg, extra),
  info: (msg: string, extra?: unknown) => write("info", msg, extra),
  warn: (msg: string, extra?: unknown) => write("warn", msg, extra),
  error: (msg: string, extra?: unknown) => write("error", msg, extra),
};
