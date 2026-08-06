import type { Pool } from 'pg';
import {
  percentile,
  blendComponentPercentiles,
  componentWeights,
  DEFAULT_WIN_WEIGHT,
  recencyWeight,
  DEFAULT_HALF_LIFE_DAYS,
  shrinkToNeutral,
  weightedMean,
} from '@power-ranking/rating-engine';

/** Bumped from 1 when the flat career average was replaced -- see playerRating.ts. */
const PLAYER_RATING_METHOD_VERSION = 2;

/** A player's recency-weighted profile within one (league, role) peer group. */
interface PlayerGroupStats {
  playerId: number;
  role: string;
  leagueId: number;
  kda: number;
  goldShare: number;
  damageShare: number;
  killParticipation: number;
  winRate: number;
  /** Raw game count, for display and for the stored games_played column. */
  gamesPlayed: number;
  /** Recency-weighted game count -- what shrinkage actually keys off. */
  effectiveGames: number;
}

/** One row of `player_game_performance` joined to its game, as the SQL below returns it. */
export interface PlayerGameRow {
  player_id: number;
  role: string;
  league_id: number;
  kda: string;
  gold_share: string | null;
  damage_share: string | null;
  kill_participation: string | null;
  won: boolean;
  age_days: string;
}

/**
 * Folds per-game rows into one recency-weighted profile per
 * (player, role, league).
 */
export function buildPlayerGroupStats(
  rows: PlayerGameRow[],
  halfLifeDays = DEFAULT_HALF_LIFE_DAYS,
): PlayerGroupStats[] {
  interface Accumulator {
    playerId: number;
    role: string;
    leagueId: number;
    kda: number[];
    goldShare: number[];
    damageShare: number[];
    killParticipation: number[];
    won: number[];
    weights: number[];
  }

  const accumulators = new Map<string, Accumulator>();
  for (const row of rows) {
    const key = `${row.player_id}::${row.role}::${row.league_id}`;
    let acc = accumulators.get(key);
    if (!acc) {
      acc = {
        playerId: row.player_id,
        role: row.role,
        leagueId: row.league_id,
        kda: [],
        goldShare: [],
        damageShare: [],
        killParticipation: [],
        won: [],
        weights: [],
      };
      accumulators.set(key, acc);
    }
    acc.kda.push(Number(row.kda));
    // The source leaves these null for some games; a missing share is not a
    // zero share, so fall back to the role-neutral 0.2 (one fifth of the team)
    // rather than letting a gap read as a terrible game.
    acc.goldShare.push(row.gold_share !== null ? Number(row.gold_share) : 0.2);
    acc.damageShare.push(row.damage_share !== null ? Number(row.damage_share) : 0.2);
    acc.killParticipation.push(row.kill_participation !== null ? Number(row.kill_participation) : 0.5);
    acc.won.push(row.won ? 1 : 0);
    acc.weights.push(recencyWeight(Number(row.age_days), halfLifeDays));
  }

  return [...accumulators.values()].map((acc) => ({
    playerId: acc.playerId,
    role: acc.role,
    leagueId: acc.leagueId,
    kda: weightedMean(acc.kda, acc.weights),
    goldShare: weightedMean(acc.goldShare, acc.weights),
    damageShare: weightedMean(acc.damageShare, acc.weights),
    killParticipation: weightedMean(acc.killParticipation, acc.weights),
    winRate: weightedMean(acc.won, acc.weights),
    gamesPlayed: acc.weights.length,
    effectiveGames: acc.weights.reduce((sum, w) => sum + w, 0),
  }));
}

/** The single rating row that will be written for one player. */
export interface PrimaryPlayerRating {
  rating: number;
  gamesPlayed: number;
  effectiveGames: number;
}

/**
 * Percentiles every profile against its (league, role) peers, blends and
 * shrinks it, then keeps each player's primary profile -- the one backed by
 * the most recency-weighted games.
 */
export function selectPrimaryRatings(
  groupStats: PlayerGroupStats[],
  winWeight = DEFAULT_WIN_WEIGHT,
): Map<number, PrimaryPlayerRating> {
  const weights = componentWeights(winWeight);
  const peerGroups = new Map<string, PlayerGroupStats[]>();
  for (const player of groupStats) {
    const key = `${player.leagueId}::${player.role}`;
    if (!peerGroups.has(key)) peerGroups.set(key, []);
    peerGroups.get(key)!.push(player);
  }

  const bestByPlayer = new Map<number, PrimaryPlayerRating>();
  for (const peers of peerGroups.values()) {
    const kdaPeers = peers.map((p) => p.kda);
    const goldPeers = peers.map((p) => p.goldShare);
    const damagePeers = peers.map((p) => p.damageShare);
    const kpPeers = peers.map((p) => p.killParticipation);
    const winPeers = peers.map((p) => p.winRate);

    for (const player of peers) {
      const blended = blendComponentPercentiles(
        {
          kda: percentile(player.kda, kdaPeers),
          goldShare: percentile(player.goldShare, goldPeers),
          damageShare: percentile(player.damageShare, damagePeers),
          killParticipation: percentile(player.killParticipation, kpPeers),
          winRate: percentile(player.winRate, winPeers),
        },
        weights,
      );

      const incumbent = bestByPlayer.get(player.playerId);
      if (!incumbent || player.effectiveGames > incumbent.effectiveGames) {
        bestByPlayer.set(player.playerId, {
          rating: shrinkToNeutral(blended, player.effectiveGames),
          gamesPlayed: player.gamesPlayed,
          effectiveGames: player.effectiveGames,
        });
      }
    }
  }
  return bestByPlayer;
}

/** One row per player-game, with everything the composite needs. */
export async function fetchPlayerGameRows(pool: Pool): Promise<PlayerGameRow[]> {
  const result = await pool.query<PlayerGameRow>(`
    SELECT
      pgp.player_id,
      pgp.role,
      tlm.league_id,
      (pgp.kills + pgp.assists)::numeric / GREATEST(pgp.deaths, 1) AS kda,
      pgp.gold_share,
      pgp.damage_share,
      pgp.kill_participation,
      (g.winner_team_id = pgp.team_id) AS won,
      EXTRACT(EPOCH FROM (NOW() - g.datetime_utc)) / 86400 AS age_days
    FROM player_game_performance pgp
    JOIN games g ON g.id = pgp.game_id
    JOIN team_league_memberships tlm ON tlm.team_id = pgp.team_id AND tlm.end_date IS NULL
  `);
  return result.rows;
}

/**
 * Season player rating: each player's recency-weighted per-game stats (KDA,
 * gold share, damage share, kill participation -- using the source's own
 * precomputed share columns -- plus win rate) percentiled against
 * peers in the same role + league (never globally -- see plan's
 * within-league-only decision), blended via `componentWeights(winWeight)`, then
 * shrunk toward the peer-neutral 50 by sample size.
 *
 * Emits exactly ONE row per player. A player who changed role or league has
 * stats in more than one peer group; the group with the most recency-weighted
 * games wins, which is both deterministic and naturally prefers where they
 * play *now*. Every consumer reads this table with `DISTINCT ON (player_id)
 * ORDER BY as_of_date DESC` (the API's getPlayers, replayData's roster-implied
 * priors), and all rows from one run share a date -- so multiple rows per
 * player made those reads a coin flip. See playerRating.ts for the full list
 * of what v1 got wrong.
 *
 * Note: league is the team's CURRENT league (`tlm.end_date IS NULL`), not the
 * league the game was played in. That's deliberate -- the question this rating
 * answers is "how good is this player relative to the peers they face now."
 */
export async function computePlayerRatings(pool: Pool, winWeight = DEFAULT_WIN_WEIGHT): Promise<number> {
  const rows = await fetchPlayerGameRows(pool);
  const bestByPlayer = selectPrimaryRatings(buildPlayerGroupStats(rows), winWeight);
  return writeRatings(pool, bestByPlayer, 'regional');
}

// --- International ("Global" tab) ratings -------------------------------------

/**
 * Only international games from the last 3 years count. Deliberately a HARD
 * cutoff on top of the recency half-life, not instead of it: the half-life
 * alone only makes old games count for less, so as time passes a 2024 result
 * would keep leaking in at ever-smaller weight forever. This guarantees the
 * tab is always "fairly recent play." The dataset currently starts at 2024
 * MSI (27 months old), so nothing is excluded today -- this keeps it true
 * later, and it drops each event automatically as it ages out.
 */
const INTERNATIONAL_WINDOW_MONTHS = 36;

/**
 * Longer than the regional 120d because international events are sparse --
 * only 2-3 per year. At 120d a player's Worlds record would be almost fully
 * decayed before the next event, leaving the tab driven by whichever event
 * happened last. 550d spans roughly the last 4-5 events, so a full
 * international body of work is visible at once. Confirmed against real data
 * that the ordering is barely sensitive to this (365 / 550 / 730 give nearly
 * the same board), so it is chosen for stability, not to hit a target.
 */
const INTERNATIONAL_HALF_LIFE_DAYS = 550;

/**
 * Below this many international games a player is not shown at all. Note this
 * is a DISPLAY floor, not the small-sample defence -- shrinkToNeutral already
 * pulls thin samples toward 50. It exists so the tab doesn't list someone as
 * "rated internationally" off a single group-stage appearance.
 */
const MIN_INTERNATIONAL_GAMES = 5;

/**
 * Rates players using ONLY their international games, with peer groups of
 * (role) across the entire international pool -- no league dimension at all.
 *
 * This is what makes the Global tab honest: these players actually played
 * each other, so the ordering needs no cross-league calibration factor. The
 * alternative we rejected -- taking the within-league percentile and shifting
 * it by a league-strength anchor -- produced a board where the top 15 was
 * entirely LCK and the best LPL player ranked 46th, because the gaps between
 * league anchors swamped the spread within any one league.
 *
 * A player with no international games simply does not appear, rather than
 * being assigned a guessed global rating. That is the intended behaviour: we
 * have no evidence about them at this level, so we make no claim.
 */
export async function computeInternationalPlayerRatings(
  pool: Pool,
  winWeight = DEFAULT_WIN_WEIGHT,
): Promise<number> {
  // league_id is pinned to 0 so selectPrimaryRatings' (league, role) grouping
  // collapses to role-only -- one global pool per role, which is the point.
  const result = await pool.query<PlayerGameRow>(`
    SELECT
      pgp.player_id,
      pgp.role,
      0 AS league_id,
      (pgp.kills + pgp.assists)::numeric / GREATEST(pgp.deaths, 1) AS kda,
      pgp.gold_share,
      pgp.damage_share,
      pgp.kill_participation,
      (g.winner_team_id = pgp.team_id) AS won,
      EXTRACT(EPOCH FROM (NOW() - g.datetime_utc)) / 86400 AS age_days
    FROM player_game_performance pgp
    JOIN games g ON g.id = pgp.game_id
    JOIN series s ON s.id = g.series_id
    JOIN tournaments tn ON tn.id = s.tournament_id
    WHERE tn.tournament_type = 'international'
      AND g.datetime_utc > NOW() - INTERVAL '${INTERNATIONAL_WINDOW_MONTHS} months'
  `);

  const groupStats = buildPlayerGroupStats(result.rows, INTERNATIONAL_HALF_LIFE_DAYS)
    .filter((g) => g.gamesPlayed >= MIN_INTERNATIONAL_GAMES);
  const bestByPlayer = selectPrimaryRatings(groupStats, winWeight);
  return writeRatings(pool, bestByPlayer, 'international');
}

/**
 * Replaces every row for one scope. Deletes only that scope -- the two passes
 * share a table, so a blanket DELETE would have each run wipe the other's
 * output (the same footgun that made the two roster populators clobber each
 * other -- see git history for populateRosterMemberships).
 */
async function writeRatings(
  pool: Pool,
  bestByPlayer: Map<number, PrimaryPlayerRating>,
  scope: 'regional' | 'international',
): Promise<number> {
  // Same class of bug fixed in computeRatings.ts: pin the transaction to one
  // dedicated client, not pool.query() (which can hop connections per call).
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM player_ratings_history WHERE scope = $1', [scope]);
    let inserted = 0;
    const today = new Date().toISOString().slice(0, 10);

    for (const [playerId, best] of bestByPlayer) {
      await client.query(
        `INSERT INTO player_ratings_history (player_id, as_of_date, rating, games_played, method_version, scope)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [playerId, today, best.rating, best.gamesPlayed, PLAYER_RATING_METHOD_VERSION, scope],
      );
      inserted += 1;
    }
    await client.query('COMMIT');
    return inserted;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Populates player_game_performance from game_lineups + a per-game stats source (Liquipedia game rows, joined by caller). */
export interface PlayerGamePerformanceInput {
  gameId: number;
  playerId: number;
  teamId: number;
  role: string;
  kills: number;
  deaths: number;
  assists: number;
  gold: number;
  damageToChampions: number;
  goldShare: number | null;
  damageShare: number | null;
  killParticipation: number | null;
  /** Raw CS, not CS/min -- the rate is derived at read time, see migration 0007. */
  creepScore: number | null;
  /** Against the same-role opponent; null when that opponent is unresolvable. */
  goldDiff: number | null;
}

export async function upsertPlayerGamePerformance(pool: Pool, input: PlayerGamePerformanceInput): Promise<void> {
  await pool.query(
    `INSERT INTO player_game_performance (game_id, player_id, team_id, role, kills, deaths, assists, gold, damage_to_champions, gold_share, damage_share, kill_participation, creep_score, gold_diff)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (game_id, player_id) DO UPDATE SET
       kills = EXCLUDED.kills, deaths = EXCLUDED.deaths, assists = EXCLUDED.assists,
       gold = EXCLUDED.gold, damage_to_champions = EXCLUDED.damage_to_champions,
       gold_share = EXCLUDED.gold_share, damage_share = EXCLUDED.damage_share, kill_participation = EXCLUDED.kill_participation,
       creep_score = EXCLUDED.creep_score, gold_diff = EXCLUDED.gold_diff`,
    [
      input.gameId,
      input.playerId,
      input.teamId,
      input.role,
      input.kills,
      input.deaths,
      input.assists,
      input.gold,
      input.damageToChampions,
      input.goldShare,
      input.damageShare,
      input.killParticipation,
      input.creepScore,
      input.goldDiff,
    ],
  );
}
