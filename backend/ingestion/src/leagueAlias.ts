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
