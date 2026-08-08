import type { Pool } from 'pg';
import {
  percentile,
  blendComponentPercentiles,
  componentWeightsForRole,
  DEFAULT_WIN_WEIGHT,
  recencyWeight,
  DEFAULT_HALF_LIFE_DAYS,
  shrinkToNeutral,
  shrinkToward,
  transferAnchor,
  weightedMean,
  NEUTRAL_SCORE,
  DEFAULT_SHRINKAGE_GAMES,
} from '@power-ranking/rating-engine';
import {
  LEAGUE_SPLIT_START_CTE,
  playerWindowPredicate,
  RATING_WINDOWS,
  type RatingWindow,
} from '@power-ranking/shared';

// v3: per-role stat weighting, plus CS/min, gold-diff, and jungle objective control.
const PLAYER_RATING_METHOD_VERSION = 3;

interface PlayerGroupStats {
  playerId: number;
  role: string;
  leagueId: number;
  kda: number;
  goldShare: number;
  damageShare: number;
  killParticipation: number;
  winRate: number;
  // Null when the player has no game with the stat (skipped, not zeroed) -- the
  // percentile treats a null as neutral so a missing stat neither helps nor hurts.
  csMin: number | null;
  goldDiff: number | null;
  objControl: number | null;
  gamesPlayed: number;
  /** Recency-weighted game count -- what shrinkage keys off. */
  effectiveGames: number;
}

export interface PlayerGameRow {
  player_id: number;
  role: string;
  league_id: number;
  kda: string;
  gold_share: string | null;
  damage_share: string | null;
  kill_participation: string | null;
  cs_min: string | null;
  gold_diff: string | null;
  obj_control: string | null;
  won: boolean;
  age_days: string;
}

/** Folds per-game rows into one recency-weighted profile per (player, role, league). */
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
    // Nullable stats: value + its own weight, pushed only on rows that carry it.
    csMin: number[];
    csMinW: number[];
    goldDiff: number[];
    goldDiffW: number[];
    objControl: number[];
    objControlW: number[];
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
        kda: [], goldShare: [], damageShare: [], killParticipation: [], won: [], weights: [],
        csMin: [], csMinW: [], goldDiff: [], goldDiffW: [], objControl: [], objControlW: [],
      };
      accumulators.set(key, acc);
    }
    const w = recencyWeight(Number(row.age_days), halfLifeDays);
    acc.kda.push(Number(row.kda));
    // Missing share != zero share: fall back to role-neutral 0.2, not a bad game.
    acc.goldShare.push(row.gold_share !== null ? Number(row.gold_share) : 0.2);
    acc.damageShare.push(row.damage_share !== null ? Number(row.damage_share) : 0.2);
    acc.killParticipation.push(row.kill_participation !== null ? Number(row.kill_participation) : 0.5);
    acc.won.push(row.won ? 1 : 0);
    acc.weights.push(w);
    if (row.cs_min !== null) { acc.csMin.push(Number(row.cs_min)); acc.csMinW.push(w); }
    if (row.gold_diff !== null) { acc.goldDiff.push(Number(row.gold_diff)); acc.goldDiffW.push(w); }
    if (row.obj_control !== null) { acc.objControl.push(Number(row.obj_control)); acc.objControlW.push(w); }
  }

  const meanOrNull = (values: number[], weights: number[]): number | null =>
    weights.length === 0 ? null : weightedMean(values, weights);

  return [...accumulators.values()].map((acc) => ({
    playerId: acc.playerId,
    role: acc.role,
    leagueId: acc.leagueId,
    kda: weightedMean(acc.kda, acc.weights),
    goldShare: weightedMean(acc.goldShare, acc.weights),
    damageShare: weightedMean(acc.damageShare, acc.weights),
    killParticipation: weightedMean(acc.killParticipation, acc.weights),
    winRate: weightedMean(acc.won, acc.weights),
    csMin: meanOrNull(acc.csMin, acc.csMinW),
    goldDiff: meanOrNull(acc.goldDiff, acc.goldDiffW),
    objControl: meanOrNull(acc.objControl, acc.objControlW),
    gamesPlayed: acc.weights.length,
    effectiveGames: acc.weights.reduce((sum, w) => sum + w, 0),
  }));
}

export interface PlayerGroupRating {
  playerId: number;
  leagueId: number;
  role: string;
  rating: number;
  gamesPlayed: number;
  effectiveGames: number;
  /** The group backed by the most recency-weighted games -- one per player. */
  isPrimary: boolean;
}

/**
 * Percentiles every profile against its (league, role) peers, then blends and
 * shrinks. Returns a rating for every group a player has games in, not just the
 * biggest, so a player who moved leagues isn't shown their old league's rating.
 */
export function selectGroupRatings(
  groupStats: PlayerGroupStats[],
  _winWeight = DEFAULT_WIN_WEIGHT,
): PlayerGroupRating[] {
  const peerGroups = new Map<string, PlayerGroupStats[]>();
  for (const player of groupStats) {
    const key = `${player.leagueId}::${player.role}`;
    if (!peerGroups.has(key)) peerGroups.set(key, []);
    peerGroups.get(key)!.push(player);
  }

  const ratings: PlayerGroupRating[] = [];
  const bestEffectiveByPlayer = new Map<number, number>();

  for (const peers of peerGroups.values()) {
    const kdaPeers = peers.map((p) => p.kda);
    const goldPeers = peers.map((p) => p.goldShare);
    const damagePeers = peers.map((p) => p.damageShare);
    const kpPeers = peers.map((p) => p.killParticipation);
    const winPeers = peers.map((p) => p.winRate);
    // Nullable stats percentile against only the peers that have them; a player
    // missing the stat gets neutral 50 so it neither helps nor hurts.
    const csPeers = peers.map((p) => p.csMin).filter((v): v is number => v !== null);
    const goldDiffPeers = peers.map((p) => p.goldDiff).filter((v): v is number => v !== null);
    const objPeers = peers.map((p) => p.objControl).filter((v): v is number => v !== null);
    const pct = (value: number | null, peerValues: number[]) => (value === null ? NEUTRAL_SCORE : percentile(value, peerValues));

    for (const player of peers) {
      const blended = blendComponentPercentiles(
        {
          kda: percentile(player.kda, kdaPeers),
          goldShare: percentile(player.goldShare, goldPeers),
          damageShare: percentile(player.damageShare, damagePeers),
          killParticipation: percentile(player.killParticipation, kpPeers),
          winRate: percentile(player.winRate, winPeers),
          csMin: pct(player.csMin, csPeers),
          goldDiff: pct(player.goldDiff, goldDiffPeers),
          objControl: pct(player.objControl, objPeers),
        },
        componentWeightsForRole(player.role),
      );

      ratings.push({
        playerId: player.playerId,
        leagueId: player.leagueId,
        role: player.role,
        rating: shrinkToNeutral(blended, player.effectiveGames),
        gamesPlayed: player.gamesPlayed,
        effectiveGames: player.effectiveGames,
        isPrimary: false,
      });
      const best = bestEffectiveByPlayer.get(player.playerId);
      if (best === undefined || player.effectiveGames > best) {
        bestEffectiveByPlayer.set(player.playerId, player.effectiveGames);
      }
    }
  }

  // Second pass: the winning group may be in a peer group processed later.
  const claimed = new Set<number>();
  for (const rating of ratings) {
    if (claimed.has(rating.playerId)) continue;
    if (rating.effectiveGames === bestEffectiveByPlayer.get(rating.playerId)) {
      rating.isPrimary = true;
      claimed.add(rating.playerId);
    }
  }

  applyTransferAnchors(ratings);
  return ratings;
}

/**
 * Re-shrinks each group toward what the player's other leagues say, not a flat
 * 50, so a newcomer with no games yet is nudged off neutral. Over the first-pass
 * values (anchoring on already-anchored siblings would be circular) and same-role
 * only (the carryover was fit on same-role pairs).
 */
function applyTransferAnchors(ratings: PlayerGroupRating[]): void {
  const byPlayer = new Map<number, PlayerGroupRating[]>();
  for (const rating of ratings) {
    if (!byPlayer.has(rating.playerId)) byPlayer.set(rating.playerId, []);
    byPlayer.get(rating.playerId)!.push(rating);
  }

  for (const groups of byPlayer.values()) {
    if (groups.length < 2) continue;
    const firstPass = groups.map((g) => g.rating);

    groups.forEach((group, index) => {
      // The best-evidenced other group at this role.
      let prior: number | null = null;
      let bestEvidence = 0;
      groups.forEach((other, otherIndex) => {
        if (otherIndex === index || other.role !== group.role) return;
        if (other.effectiveGames > bestEvidence) {
          bestEvidence = other.effectiveGames;
          prior = firstPass[otherIndex];
        }
      });
      if (prior === null) return;

      // Undo the neutral shrink to recover the raw blended score, then re-shrink
      // toward the transfer anchor.
      const confidence = group.effectiveGames / (group.effectiveGames + DEFAULT_SHRINKAGE_GAMES);
      if (confidence === 0) return;
      const blended = NEUTRAL_SCORE + (firstPass[index] - NEUTRAL_SCORE) / confidence;
      group.rating = shrinkToward(blended, group.effectiveGames, transferAnchor(prior));
    });
  }
}

/** One row per player-game, with everything the composite needs. */
export async function fetchPlayerGameRows(pool: Pool, window: RatingWindow = 'all'): Promise<PlayerGameRow[]> {
  const result = await pool.query<PlayerGameRow>(`
    WITH ${LEAGUE_SPLIT_START_CTE}
    SELECT
      pgp.player_id,
      pgp.role,
      tlm.league_id,
      (pgp.kills + pgp.assists)::numeric / GREATEST(pgp.deaths, 1) AS kda,
      pgp.gold_share,
      pgp.damage_share,
      pgp.kill_participation,
      pgp.creep_score * 60.0 / NULLIF(g.gamelength_seconds, 0) AS cs_min,
      pgp.gold_diff::numeric AS gold_diff,
      (CASE WHEN pgp.team_id = g.team1_id THEN g.team1_neutral_objectives ELSE g.team2_neutral_objectives END)::numeric
        / NULLIF(g.team1_neutral_objectives + g.team2_neutral_objectives, 0) AS obj_control,
      (g.winner_team_id = pgp.team_id) AS won,
      EXTRACT(EPOCH FROM (NOW() - g.datetime_utc)) / 86400 AS age_days
    FROM player_game_performance pgp
    JOIN games g ON g.id = pgp.game_id
    JOIN team_league_memberships tlm ON tlm.team_id = pgp.team_id AND tlm.end_date IS NULL
    LEFT JOIN league_split_start lss ON lss.canonical_league_id = tlm.league_id
    WHERE ${playerWindowPredicate(window, 'g.datetime_utc', 'lss.latest_split_start')}
  `);
  return result.rows;
}

/**
 * Season player rating: recency-weighted stats + win rate, percentiled against
 * same (league, role) peers, one row per group. League is the team's CURRENT
 * league, not where the game was played. Readers must name the group they mean:
 * a bare DISTINCT ON (player_id) ORDER BY as_of_date is a coin flip, since every
 * row from one run shares a date.
 */
export async function computePlayerRatings(
  pool: Pool,
  winWeight = DEFAULT_WIN_WEIGHT,
  window: RatingWindow = 'all',
): Promise<number> {
  const rows = await fetchPlayerGameRows(pool, window);
  const ratings = selectGroupRatings(buildPlayerGroupStats(rows), winWeight);
  return writeRatings(pool, ratings, 'regional', window);
}

/** All three regional windows -- the same method over fewer games, not a separate formula. */
export async function computeAllPlayerRatingWindows(pool: Pool, winWeight = DEFAULT_WIN_WEIGHT): Promise<number> {
  let total = 0;
  for (const window of RATING_WINDOWS) {
    total += await computePlayerRatings(pool, winWeight, window);
  }
  return total;
}

// --- International ("Global" tab) ratings -------------------------------------

// Hard cutoff on top of the half-life, which alone would leak old events in at
// ever-smaller weight forever.
const INTERNATIONAL_WINDOW_MONTHS = 36;

// Longer than the regional 120d because international events are sparse; 550d
// spans 4-5 events. Ordering is barely sensitive to it.
const INTERNATIONAL_HALF_LIFE_DAYS = 550;

// Display floor, not the small-sample defence (shrinkToNeutral handles that):
// stops the tab listing someone off a short run of international games.
const MIN_INTERNATIONAL_GAMES = 10;

/**
 * Rates players on international games only, role-only peer groups. These players
 * actually played each other, so no cross-league calibration is needed. A player
 * with no international games simply doesn't appear.
 */
export async function computeInternationalPlayerRatings(
  pool: Pool,
  winWeight = DEFAULT_WIN_WEIGHT,
): Promise<number> {
  // league_id pinned to 0 so the (league, role) grouping collapses to role-only.
  const result = await pool.query<PlayerGameRow>(`
    SELECT
      pgp.player_id,
      pgp.role,
      0 AS league_id,
      (pgp.kills + pgp.assists)::numeric / GREATEST(pgp.deaths, 1) AS kda,
      pgp.gold_share,
      pgp.damage_share,
      pgp.kill_participation,
      pgp.creep_score * 60.0 / NULLIF(g.gamelength_seconds, 0) AS cs_min,
      pgp.gold_diff::numeric AS gold_diff,
      (CASE WHEN pgp.team_id = g.team1_id THEN g.team1_neutral_objectives ELSE g.team2_neutral_objectives END)::numeric
        / NULLIF(g.team1_neutral_objectives + g.team2_neutral_objectives, 0) AS obj_control,
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
  const ratings = selectGroupRatings(groupStats, winWeight);
  return writeRatings(pool, ratings, 'international');
}

/**
 * Replaces every row for one (scope, window), deleting only that pair -- all four
 * passes share the table, so a blanket DELETE would have each run wipe the others.
 */
async function writeRatings(
  pool: Pool,
  ratings: PlayerGroupRating[],
  scope: 'regional' | 'international',
  window: RatingWindow = 'all',
): Promise<number> {
  // Pin the transaction to one client, not pool.query() (which can hop connections).
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM player_ratings_history WHERE scope = $1 AND rating_window = $2', [scope, window]);
    let inserted = 0;
    const today = new Date().toISOString().slice(0, 10);

    for (const rating of ratings) {
      await client.query(
        `INSERT INTO player_ratings_history
           (player_id, as_of_date, rating, games_played, method_version, scope, league_id, role, is_primary, rating_window)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          rating.playerId,
          today,
          rating.rating,
          rating.gamesPlayed,
          PLAYER_RATING_METHOD_VERSION,
          scope,
          // International groups are role-only, so there's no league to record.
          scope === 'international' ? null : rating.leagueId,
          rating.role,
          rating.isPrimary,
          window,
        ],
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
