/**
 * DEAD IN PRODUCTION -- kept deliberately, flagged rather than deleted.
 *
 * This resolves a raw league name at a point in time to a canonical league,
 * and the league_aliases table it reads holds a real quirk: through 2025 the
 * Americas ran as LTA North and LTA South, so historical records appear under
 * "LTA N"/"LTAN" and "LTA S"/"LTAS" and must map onto LCS and CBLOL for a
 * team's history to stay continuous across the rename.
 *
 * Nothing calls it any more. The only callers were the Oracle's Elixir and
 * Leaguepedia Cargo ingest paths, both since deleted. The Liquipedia match
 * ingest that replaced them classifies tournaments through liquipediaMappings
 * instead and never consults this table.
 *
 * Deleting it would throw away the only encoding of that rename. Keeping it
 * unused risks the next ingest path silently skipping the remap the way this
 * one does. Neither is obviously right, so it is left here with the question
 * stated: does the Liquipedia path handle the LTA rename correctly on its own,
 * or is it quietly mis-attributing 2025 Americas history?
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
