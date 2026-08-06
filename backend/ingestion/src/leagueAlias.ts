/**
 * Currently uncalled, and that is a SYMPTOM rather than a reason to delete it.
 *
 * This resolves a raw league name at a point in time to a canonical league.
 * The league_aliases table it reads holds a real quirk: through 2025 the
 * Americas ran as LTA North and LTA South, so records from that year appear
 * under "LTA N"/"LTAN" and "LTA S"/"LTAS" and must map onto LCS and CBLOL for
 * a team's history to stay continuous across the rename.
 *
 * The reason nothing calls it is that the 2025 Americas season was never
 * ingested at all. Confirmed against the data: LCS and CBLOL hold zero
 * regional games for 2025, while every other league has a full year --
 * LEC 308, LPL 817, LCK 535. The Liquipedia backfill is driven by series
 * name, and "LCS"/"CBLOL" simply did not exist that year, so the query
 * matched nothing and failed silently.
 *
 * Consequences worth knowing before this is either used or removed:
 *   - LCS teams rate on 366 games against LEC's 882, and carry a 14-month
 *     hole between mid-2024 and early 2026.
 *   - That gap is very likely part of why LCS measures as the most
 *     under-rated region (winning 43.0% of cross-league games against a
 *     prediction near 37%) -- see MODEL.md.
 *
 * The fix is to backfill the 2025 LTA North and LTA South splits, at which
 * point this module becomes load-bearing again: it is what maps those records
 * back onto LCS and CBLOL. Backfilling will move every rating, so the tuned
 * parameters should be re-swept afterwards.
 */
/**
 * Resolves a raw league/region name as it appears in Leaguepedia to a
 * canonical league id, valid over a date range -- the mechanism behind the
 * LTAN->LCS / LTAS->CBLOL historical remap. Mirrors the league_aliases table.
 */

export interface LeagueAlias {
  rawLeagueName: string;
  canonicalLeagueId: number;
  /** ISO date string, e.g. '2025-01-01' -- or a real Date, since that's what `pg` actually returns for DATE columns. */
  validFrom: string | Date;
  /** ISO date string, a real Date, or null if still in effect. */
  validTo: string | Date | null;
}

/**
 * Normalizes a date-like value (string OR a real Date object, which is what
 * `pg` actually returns for DATE columns, not the string its type declares)
 * into a comparable YYYY-MM-DD string. Confirmed as a real, previously-silent
 * bug: comparing a string against an un-normalized Date object via `>=`
 * coerces the Date to a number (ms since epoch) and the string to NaN, so
 * the comparison is always false -- resolveLeagueAlias was returning null
 * for every single call in production despite passing unit tests that only
 * ever exercised it with clean string literals, never real DB round-trips.
 */
function toDateString(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

/**
 * Returns the canonical league id for a raw name as of a given date, or null
 * if unresolved. Callers must never guess when this returns null -- log and
 * quarantine the row instead (see plan: "never silently guessed into the
 * 6-league scope").
 */
export function resolveLeagueAlias(
  rawLeagueName: string,
  asOfDate: string | Date,
  aliases: LeagueAlias[],
): number | null {
  const asOfDateStr = toDateString(asOfDate);
  const match = aliases.find((alias) => {
    if (alias.rawLeagueName !== rawLeagueName) return false;
    const validFrom = toDateString(alias.validFrom);
    const validTo = alias.validTo === null ? null : toDateString(alias.validTo);
    return asOfDateStr >= validFrom && (validTo === null || asOfDateStr <= validTo);
  });
  return match ? match.canonicalLeagueId : null;
}
