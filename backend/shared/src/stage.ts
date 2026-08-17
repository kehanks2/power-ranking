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
    const played = stages
      .filter((s): s is StageStatus & { lastPlayedDay: string } => s.lastPlayedDay !== null)
      .sort((a, b) => (a.lastPlayedDay < b.lastPlayedDay ? -1 : 1));

    if (played.length === 0) {
      advances.push({ leagueId, asOfDate: null, stage: null, reason: 'no-data' });
      continue;
    }

    const current = played[played.length - 1];
    const settled = (reason: AdvanceReason): BoardAdvance => ({
      leagueId,
      asOfDate: current.lastPlayedDay,
      stage: current.bracketId,
      reason,
    });

    if (stageKind(current.bracketId) === 'bracket') {
      advances.push(settled('bracket'));
    } else if (current.unplayedSeries === 0) {
      advances.push(settled('stage-complete'));
    } else if (daysBetween(current.lastPlayedDay, today) >= STAGE_STALL_DAYS) {
      advances.push(settled('stage-stalled'));
    } else {
      const previous = played[played.length - 2];
      advances.push({
        leagueId,
        asOfDate: previous?.lastPlayedDay ?? null,
        stage: previous?.bracketId ?? null,
        reason: previous ? 'holding' : 'no-data',
      });
    }
  }
  return advances;
}

/**
 * Per (league, stage) status for `resolveBoardAdvance`. Regional only --
 * international play is bracket-shaped throughout and advances per series.
 */
export const STAGE_STATUS_SQL = `
  SELECT t.canonical_league_id            AS league_id,
         s.bracket_id                     AS bracket_id,
         max(g.day)::date::text           AS last_played_day,
         count(*) FILTER (WHERE g.day IS NULL) AS unplayed_series
    FROM series s
    JOIN tournaments t ON t.id = s.tournament_id
    LEFT JOIN LATERAL (
      SELECT max(datetime_utc) AS day FROM games WHERE series_id = s.id
    ) g ON true
   WHERE t.canonical_league_id IS NOT NULL
     AND t.tournament_type <> 'international'
   GROUP BY t.canonical_league_id, s.bracket_id
`;
