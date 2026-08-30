/**
 * What a board shows for a team.
 *
 * Names are shown in full: they are how people refer to a team, and an
 * ellipsis in a column that had room was the previous state. Only one active
 * team is long enough to distort a column -- LCP's "Fukuoka SoftBank HAWKS
 * gaming" at 29 characters, against 19 for the next longest -- so this drops a
 * trailing generic word from a name over the limit and leaves every other name
 * exactly as it is.
 */
const MAX_DISPLAY_CHARS = 22;

/** Dropped only from an over-long name, and only from the end. "GAM Esports" keeps its. */
const GENERIC_SUFFIXES = ['gaming', 'esports', 'e-sports', 'esports club'];

export function displayTeamName(name: string | null): string {
  if (!name || name.length <= MAX_DISPLAY_CHARS) return name ?? '';

  const lower = name.toLowerCase();
  for (const suffix of GENERIC_SUFFIXES) {
    if (!lower.endsWith(` ${suffix}`)) continue;
    const shortened = name.slice(0, name.length - suffix.length - 1).trimEnd();
    // Never leave a bare word standing in for an org: dropping the suffix has
    // to leave something that still reads as the team's name.
    if (shortened.length >= 3) return shortened;
  }
  return name;
}
