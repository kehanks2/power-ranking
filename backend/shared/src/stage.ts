/**
 * Liquipedia stamps every series with a stage marker (`match2bracketid`), e.g.
 * `LCK26Sp3W3` for a regular-season week or `LCS26SPRPO` for a playoff bracket.
 *
 * The two need opposite cadences. Round-robin play should move a board only
 * once the whole week is in: a team that plays Saturday otherwise leapfrogs a
 * rival who plays Sunday and falls back the next day, which is an artefact of
 * the schedule rather than evidence. Bracket play is the reverse -- every
 * series is decisive and elimination is news -- so it advances per series.
 *
 * This is a table of patterns rather than one regex because the convention is
 * per-league and genuinely inconsistent. Anything unrecognised counts as
 * bracket play, so a convention change degrades to per-series updates (today's
 * behaviour) instead of freezing a board.
 */
export const REGULAR_SEASON_STAGE_PATTERNS: readonly RegExp[] = [
  /W\d+$/, // LCK26Sp3W3, LCS26SumW4, CBL26CupW1, and LEC's zero-padded LEC26VsW01
  /RS\d+$/, // 26LPLS3RS4, LCP26S2RS7
  /^CBLOL\d\dS\d\d$/, // CBLOL26S17 -- split 1, week 7
];

export type StageKind = 'regular' | 'bracket';

/** A missing marker reads as bracket play: series predating migration 0016 keep advancing per game day. */
export function stageKind(bracketId: string | null | undefined): StageKind {
  if (!bracketId) return 'bracket';
  return REGULAR_SEASON_STAGE_PATTERNS.some((pattern) => pattern.test(bracketId)) ? 'regular' : 'bracket';
}

/** Stage markers that name a knockout bracket. Every league spells it differently. */
export const PLAYOFF_STAGE_PATTERNS: readonly RegExp[] = [
  /PO/, // LCS26SPRPO, LEC26SprPO, LCKCup26PO, LCP26S1POB, LCP26Sp2PO, LCP26SFPO1
  /Kn|KO/, // LPL26S1KnO, LPL26S1KnR, 26LPLS2KnR, 26LPLS2KOS, FST26KnOut
  /Brakt/, // MSI26Brakt
];

/**
 * Whether a stage is knockout play, for LABELLING a series. Deliberately not
 * `stageKind`: that answers "may the board advance yet" and reads anything
 * unrecognised as bracket, which is the right fail-safe there but painted all of
 * LCS 2026 Lock-In as playoffs -- its group stages (LCS26LIN2H, LIN3M, LINR1)
 * match no regular-season pattern either.
 *
 * Three-valued on purpose. Null means we do not know, and nothing is drawn:
 * guessing is what produced the false positives, and a Swiss round or a play-in
 * is neither regular season nor a playoff.
 *
 * Format is NOT a substitute, measured across every 2026 series carrying a
 * marker: 37 Bo5 series sit in non-playoff stages (LCKCup26W3 is a regular
 * season week of Bo5s) and LEC's playoff bracket contains Bo3s.
 */
export function isPlayoffStage(bracketId: string | null | undefined): boolean | null {
  if (!bracketId) return null;
  if (PLAYOFF_STAGE_PATTERNS.some((pattern) => pattern.test(bracketId))) return true;
  if (REGULAR_SEASON_STAGE_PATTERNS.some((pattern) => pattern.test(bracketId))) return false;
  return null;
}

/**
 * Days a regular-season stage may go without a new result before the board
 * advances regardless. Guards a postponed or cancelled fixture -- or a schedule
 * we have wrong -- freezing a board indefinitely.
 *
 * 2 is safe by measurement, not by feel: across 82 regular-season stages in all
 * six leagues in 2026, the worst gap between consecutive play days inside a
 * stage is 1 day, with no exceptions. Brackets reach 11, which is why this
 * applies only to regular season.
 */
export const STAGE_STALL_DAYS = 2;

/** One row per (league, stage): when it last produced a result, and what it still owes. */
export interface StageStatus {
  leagueId: number;
  bracketId: string | null;
  /** Last day a game in this stage was played, or null if none has been. */
  lastPlayedDay: string | null;
  /**
   * The play day before that, within the same stage. Bracket carets measure
   * from it: every series of a playoff shares one bracket id, so "the previous
   * stage" can be the end of the regular season for weeks at a time.
   */
  previousPlayedDay: string | null;
  /** Series in this stage with no games yet -- Liquipedia's -1 to -1 fixtures. */
  unplayedSeries: number;
}

export type AdvanceReason =
  | 'bracket' // every series decisive, so move immediately
  | 'stage-complete' // the week is fully played
  | 'stage-stalled' // fail-safe: the week went quiet with fixtures outstanding
  | 'holding' // mid-week, board pinned to the last completed stage
  | 'no-data';

export interface BoardAdvance {
  leagueId: number;
  /** The day the board should read as of, or null when nothing is showable. */
  asOfDate: string | null;
  /** The stage that date came from, for display and diagnosis. */
  stage: string | null;
  reason: AdvanceReason;
  /**
   * End of the stage before the one being shown -- what rank-change carets
   * measure from. It must be a stage boundary, not simply "before asOfDate":
   * the latter would compare the end of a week against the middle of it, which
   * is the same half-round comparison the whole mechanism exists to avoid.
   */
  previousAsOfDate: string | null;
  previousStage: string | null;
}

const DAY_MS = 86_400_000;

/** Parsed as UTC: a bare date parsed locally lands on the wrong day west of Greenwich. */
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const daysBetween = (from: string, to: string) => Math.round((dayMs(to) - dayMs(from)) / DAY_MS);

/**
 * Decides, per league, how far forward its board may read.
 *
 * Regular-season weeks are held until fully played, so a board reflects a whole
 * round of fixtures rather than whoever happened to play first. Brackets move
 * per series. A week that goes STAGE_STALL_DAYS without a new result while
 * still owing fixtures is released anyway, so a postponed match or a schedule
 * we have wrong cannot freeze a board indefinitely.
 *
 * Pure so it can be tested against real stage vocabulary; callers supply the
 * rows and today's date.
 */
export function resolveBoardAdvance(rows: StageStatus[], today: string): BoardAdvance[] {
  const byLeague = new Map<number, StageStatus[]>();
  for (const row of rows) {
    if (!byLeague.has(row.leagueId)) byLeague.set(row.leagueId, []);
    byLeague.get(row.leagueId)!.push(row);
  }

  const advances: BoardAdvance[] = [];
  for (const [leagueId, stages] of byLeague) {
    // localeCompare-style comparator, returning 0 for equal days: a comparator
    // that never returns 0 is inconsistent, and two stages ending the same day
    // is routine where a regular season's last game and its first bracket
    // series share a date -- which of them counted as current was arbitrary.
    // The tie breaks toward bracket play, which is the later stage in practice.
    const played = stages
      .filter((s): s is StageStatus & { lastPlayedDay: string } => s.lastPlayedDay !== null)
      .sort((a, b) => {
        if (a.lastPlayedDay !== b.lastPlayedDay) return a.lastPlayedDay < b.lastPlayedDay ? -1 : 1;
        return Number(stageKind(a.bracketId) === 'bracket') - Number(stageKind(b.bracketId) === 'bracket');
      });

    if (played.length === 0) {
      advances.push({
        leagueId,
        asOfDate: null,
        stage: null,
        reason: 'no-data',
        previousAsOfDate: null,
        previousStage: null,
      });
      continue;
    }

    const current = played[played.length - 1];
    let shownIndex: number;
    let reason: AdvanceReason;

    if (stageKind(current.bracketId) === 'bracket') {
      shownIndex = played.length - 1;
      reason = 'bracket';
    } else if (current.unplayedSeries === 0) {
      shownIndex = played.length - 1;
      reason = 'stage-complete';
    } else if (daysBetween(current.lastPlayedDay, today) >= STAGE_STALL_DAYS) {
      shownIndex = played.length - 1;
      reason = 'stage-stalled';
    } else {
      shownIndex = played.length - 2;
      reason = shownIndex >= 0 ? 'holding' : 'no-data';
    }

    const shown = shownIndex >= 0 ? played[shownIndex] : undefined;
    const previous = shownIndex >= 1 ? played[shownIndex - 1] : undefined;

    // A bracket advances per series, so its carets must too -- measuring from
    // the previous stage would compare across the whole playoff run, since all
    // of it shares one bracket id. Falls back to the previous stage on a
    // bracket's opening day, when there is no earlier day inside it.
    const withinStage = shown && reason === 'bracket' ? shown.previousPlayedDay : null;
    advances.push({
      leagueId,
      asOfDate: shown?.lastPlayedDay ?? null,
      stage: shown?.bracketId ?? null,
      reason,
      previousAsOfDate: withinStage ?? previous?.lastPlayedDay ?? null,
      previousStage: withinStage ? (shown?.bracketId ?? null) : (previous?.bracketId ?? null),
    });
  }
  return advances;
}

/**
 * Per (league, stage) status for `resolveBoardAdvance`, plus the data frontier
 * the stall window is measured against. Regional only -- international play is
 * bracket-shaped throughout and advances per series.
 *
 * `$1` optionally narrows to one league slug, and the frontier rides along on
 * every row, so a board costs ONE round trip rather than three. That matters
 * more than the query does: the statement runs in ~7ms, while each extra trip
 * to a hosted database costs a hundred times that.
 */
export const STAGE_STATUS_SQL = `
  WITH frontier AS (SELECT max(datetime_utc)::date::text AS day FROM games)
  SELECT t.canonical_league_id            AS league_id,
         l.slug                           AS league_slug,
         s.bracket_id                     AS bracket_id,
         max(g.day)::date::text           AS last_played_day,
         -- Second-newest day of play inside the stage, for bracket carets.
         (array_agg(DISTINCT g.day::date ORDER BY g.day::date DESC) FILTER (WHERE g.day IS NOT NULL))[2]::text
                                          AS previous_played_day,
         count(*) FILTER (WHERE g.day IS NULL) AS unplayed_series,
         (SELECT day FROM frontier)       AS frontier_day
    FROM series s
    JOIN tournaments t ON t.id = s.tournament_id
    JOIN leagues l ON l.id = t.canonical_league_id
    LEFT JOIN LATERAL (
      SELECT max(datetime_utc) AS day FROM games WHERE series_id = s.id
    ) g ON true
   WHERE t.tournament_type <> 'international'
     AND ($1::text IS NULL OR l.slug = $1)
   GROUP BY t.canonical_league_id, l.slug, s.bracket_id
`;
