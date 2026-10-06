import type { Env } from "./env.ts";
import type { LeadPayload } from "./lead-types.ts";
import { parseLead } from "./leads.ts";

const SITE_URL = "https://3x3.team";
const FETCH_TIMEOUT_MS = 8000;

// Recent leads are read from the site's database (the source of truth); the bot
// keeps no copy. Throws when the site is unreachable or answers badly.
export async function fetchRecentLeads(env: Env, count = 5, fetchImpl: typeof fetch = fetch): Promise<LeadPayload[]> {
  if (!env.RELAY_SECRET) throw new Error("RELAY_SECRET is not set");
  const res = await fetchImpl(`${SITE_URL}/api/bot/leads?limit=${count}`, {
    headers: { Authorization: `Bearer ${env.RELAY_SECRET}`, Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`site responded ${res.status}`);
  const body = (await res.json()) as { leads?: unknown };
  if (!Array.isArray(body.leads)) throw new Error("unexpected response shape");
  return body.leads.map(parseLead).filter((l): l is LeadPayload => l !== null);
}
