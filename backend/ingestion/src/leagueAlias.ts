/**
 * Resolves a raw Leaguepedia league name at a point in time to a canonical
 * league id -- the LTAN->LCS / LTAS->CBLOL historical remap, since through 2025
 * the Americas ran as LTA North and LTA South. Mirrors the league_aliases table.
 *
 * Uncalled, and that is a SYMPTOM, not a reason to delete it: the 2025 Americas
 * season was never ingested (LCS and CBLOL hold zero 2025 games), because the
 * backfill matches on series name and "LCS"/"CBLOL" did not exist that year.
 * Backfilling those splits makes this load-bearing again and will move every
 * rating -- re-sweep the tuned parameters afterwards. See MODEL.md.
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
 * To a comparable YYYY-MM-DD string. `pg` returns real Dates for DATE columns,
 * not the strings its types declare, and comparing a string to a Date with `>=`
 * coerces both to numbers and is always false -- this returned null for every
 * production call while unit tests passed on string literals.
 */
function toDateString(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

/**
 * Canonical league id for a raw name as of a date, or null. Callers must never
 * guess on null -- log and quarantine the row instead.
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
