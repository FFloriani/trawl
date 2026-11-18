import { config } from "../config.ts";

// The user's own logged-in Reddit session (REDDIT_COOKIE, opt-in). Since nov/2026 Reddit answers
// many IPs without a session with a 403 "blocked by network security" page, on the JSON search
// and on the site's own search: with the session, the site search and the JSON of a thread still
// answer. The cookie only ever goes to reddit.com. A 403 with the block page is about the address,
// not about the cookie, so it never marks the session as rejected.

let rejected = "";

/** Cookie header for reddit.com, or undefined when there is no usable session. */
export function sessionCookie(): string | undefined {
  const v = config.keys.redditCookie ?? "";
  if (!v || rejected) return undefined;
  return v.includes("=") ? v : `reddit_session=${v}`;
}

export const hasSession = (): boolean => Boolean(sessionCookie());

/** Why the session stopped being used, if it did. */
export const sessionRejected = (): string => rejected;

export function rejectSession(): void {
  rejected =
    "o Reddit recusou o cookie da sessão (expirado ou inválido); atualize REDDIT_COOKIE no .env da pasta de dados (trawl_doctor mostra onde)";
}

/** Reddit's network-security block page (answered with 403 to addresses it does not trust). */
export function isNetworkBlock(text: string): boolean {
  return /blocked by network security/i.test(text);
}

export const BLOCK_NOTE =
  "o Reddit bloqueia este endereço sem sessão logada (403 \"blocked by network security\"); com REDDIT_COOKIE a busca do site e a leitura das conversas voltam a funcionar";
