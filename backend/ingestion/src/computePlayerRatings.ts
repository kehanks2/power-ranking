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
  detectRosterChanges,
  type Role,
  type RosterChangeEvent,
} from '@power-ranking/rating-engine';
import { buildTeamLineupGames } from './teamLineups.js';

// Deliberately higher than the rating-decay threshold (2, in computeRatings.ts).
// Confirmed against real data: Cloud9's 2026-08-01 games had scrambled
// position labels in the source CSV for all 5 of the team's existing players
// (not a real in-game role swap -- confirmed directly against the raw file,
// and corrected at the data level for this specific case). A higher
// persistence threshold is still the right defensive posture against any
// similar undetected source-data corruption elsewhere, since this table has
// no self-correcting mechanism the way rating decay does (next paragraph).
// Rating decay can afford a low threshold because it's self-correcting (the
// next real game's result pulls a wrongly-decayed rating back); the roster
// DISPLAY table has no such correction -- it just shows whatever this
// threshold decided, so it needs to be more conservative before declaring a
// role change "real."
const ROSTER_DISPLAY_PERSISTENCE_GAMES = 5;
const ROLES: Role[] = ['TOP', 'JNG', 'MID', 'BOT', 'SUP'];
// How far back from a team's most recent game counts as "currently on the
// roster" for substitute purposes. Confirmed against real data this was
// missing entirely: Cloud9 carries a 7-man roster (5 primaries + Loki and
// Tactical as subs), and LYON currently plays Armao in place of their usual
// jungler -- none of them ever "win" a role outright the way detectRosterChanges
// requires for a primary, so they were invisible in the roster display even
// though they're genuinely playing for the team.
// Originally 90 days -- confirmed against real data that was too generous:
// LYON's Castle (TOP) hadn't played a single game in 77 days (dropped after
// MSI) but 77 < 90, so he stayed listed as a live substitute indefinitely.
// A genuinely active substitute rotation shows up more often than that; 45
// days gives real recent subs (e.g. Cloud9's Loki/Tactical, days-old at the
// time) plenty of room while dropping a player nobody's fielded in months.
// This second pass doesn't touch the primary-occupant logic above; it only
// adds is_starter=false rows
// for anyone else who appeared in that role recently.
const SUBSTITUTE_WINDOW_DAYS = 45;

/**
 * @deprecated SUPERSEDED by populateRosterFromLiquipedia. Do not wire this back
 * into any ingest path. It and the Liquipedia populator both begin with
 * `DELETE FROM roster_memberships`, so calling both means whichever ran last
 * silently wins -- that is exactly how the LCS rosters regressed after being
 * fixed (an OE ingest run reverted them). Rosters now come from Liquipedia's
 * own squad data, which models bench players and shared positions as
 * first-class states this lineup-persistence heuristic cannot represent.
 * Retained only for its test coverage of the heuristic; safe to delete once
 * that is no longer wanted.
 *
 * Backfills roster_memberships as genuine date-ranged history, reusing the
 * same `detectRosterChanges` module the rating engine uses for roster-decay
 * events -- NOT a per-role "current occupant" snapshot inferred fresh each
 * time. Two reasons this matters (both confirmed against real data):
 *
 * 1. A single anomalous game-lineup row (a scraping quirk or a genuine
 *    one-off in-game position experiment) must never override an established
 *    player -- detectRosterChanges already requires N consecutive games
 *    before counting a change, so a lone anomaly produces zero events, not a
 *    false membership row. (Earlier attempts at plain "most recent game" and
 *    even a windowed majority-vote were both still snapshots, discarding
 *    the actual history a genuine substitute stretch should leave behind.)
 * 2. A real substitute who plays a real stretch of games (a 6th/7th man
 *    filling in) gets their own dated membership period, distinct from the
 *    primary starter's surrounding periods -- not silently voted away.
 */
export async function populateRosterMemberships(pool: Pool): Promise<number> {
  const lineupGamesByTeam = await buildTeamLineupGames(pool);

  // Same connection-pinning fix as computeRatings.ts/computePlayerRatings:
  // DELETE + many INSERTs must run on one dedicated client to be atomic.
  const client = await pool.connect();
  let inserted = 0;
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM roster_memberships`);

    for (const [teamId, lineupGames] of lineupGamesByTeam) {
      if (lineupGames.length === 0) continue;

      const events = detectRosterChanges(lineupGames, ROSTER_DISPLAY_PERSISTENCE_GAMES);
      const eventsByRole = new Map<Role, RosterChangeEvent[]>();
      for (const event of events) {
        if (!eventsByRole.has(event.role)) eventsByRole.set(event.role, []);
        eventsByRole.get(event.role)!.push(event);
      }

      // Pass 1: determine every role's primary occupant first. Needed before
      // subs can be filtered -- see below.
      const primaryPlayerIdByRole = new Map<Role, string>();
      // Everyone who EVER held a persistent primary block in a given role,
      // not just the current one -- see pass 2, which needs this to avoid
      // re-listing a replaced former starter as if they were a live sub.
      const everPrimaryPlayerIdsByRole = new Map<Role, Set<string>>();
      for (const role of ROLES) {
        const roleEvents = (eventsByRole.get(role) ?? []).sort((a, b) => (a.effectiveAt < b.effectiveAt ? -1 : 1));

        let currentPlayerId = lineupGames[0].lineup[role];
        let currentStart = String(lineupGames[0].playedAt).slice(0, 10);
        const everPrimary = new Set<string>([currentPlayerId]);

        for (const event of roleEvents) {
          const endDate = String(event.effectiveAt).slice(0, 10);
          await client.query(
            `INSERT INTO roster_memberships (team_id, player_id, role, is_starter, start_date, end_date)
             VALUES ($1, $2, $3, true, $4, $5)`,
            [teamId, Number(currentPlayerId), role, currentStart, endDate],
          );
          inserted += 1;
          currentPlayerId = event.newPlayerId;
          currentStart = endDate;
          everPrimary.add(currentPlayerId);
        }

        // The final, currently-open membership for this role.
        await client.query(
          `INSERT INTO roster_memberships (team_id, player_id, role, is_starter, start_date, end_date)
           VALUES ($1, $2, $3, true, $4, NULL)`,
          [teamId, Number(currentPlayerId), role, currentStart],
        );
        inserted += 1;
        primaryPlayerIdByRole.set(role, currentPlayerId);
        everPrimaryPlayerIdsByRole.set(role, everPrimary);
      }

      // Every role's established primary, as a set -- used to filter subs below.
      const allPrimaryPlayerIds = new Set(primaryPlayerIdByRole.values());

      // Pass 2: substitutes -- anyone else who played a role recently, who
      // never won a persistent-enough block to become that role's primary.
      // Two exclusions matter here, both confirmed against real data:
      // 1. Players who are ALREADY this team's primary in a DIFFERENT role.
      //    Cloud9's source data for 2026-08-01 had scrambled position labels
      //    across all 5 established starters (nobody new, nobody left -- a
      //    source-data defect, corrected at the data level for that specific
      //    case). Without this exclusion, corrupted rows like that would make
      //    every starter show up as a "substitute" in 4 other positions too.
      // 2. Players who were FORMERLY this exact role's primary before being
      //    replaced -- a genuine, completed transition (e.g. Denathor
      //    replacing Photon at Dignitas TOP, or FenRir replacing Aiming at KT
      //    Rolster BOT). Without this exclusion, every real roster swap left
      //    the departed starter listed as an open-ended "substitute" forever,
      //    since their games still fall inside the recency window below --
      //    duplicating them across the old and new team in the player list.
      // A genuine sub is someone who never won a persistent block in this
      // role at all, for anyone, ever -- just recent appearances that lost
      // out to the current primary.
      for (const role of ROLES) {
        const currentPlayerId = primaryPlayerIdByRole.get(role)!;
        const everPrimaryThisRole = everPrimaryPlayerIdsByRole.get(role)!;
        const mostRecentGameAt = lineupGames[lineupGames.length - 1].playedAt;
        const windowStart = new Date(mostRecentGameAt);
        windowStart.setDate(windowStart.getDate() - SUBSTITUTE_WINDOW_DAYS);

        const subAppearances = new Map<string, string>(); // playerId -> first appearance in window
        for (const game of lineupGames) {
          if (new Date(game.playedAt) < windowStart) continue;
          const playerInRole = game.lineup[role];
          if (playerInRole === currentPlayerId) continue;
          if (allPrimaryPlayerIds.has(playerInRole)) continue; // an existing starter elsewhere, not a real sub
          if (everPrimaryThisRole.has(playerInRole)) continue; // a former primary in THIS role, replaced -- not a live sub
          if (!subAppearances.has(playerInRole)) subAppearances.set(playerInRole, String(game.playedAt).slice(0, 10));
        }
        for (const [subPlayerId, firstSeenDate] of subAppearances) {
          await client.query(
            `INSERT INTO roster_memberships (team_id, player_id, role, is_starter, start_date, end_date)
             VALUES ($1, $2, $3, false, $4, NULL)`,
            [teamId, Number(subPlayerId), role, firstSeenDate],
          );
          inserted += 1;
        }
      }
    }

    // Global cross-team cleanup: a real player is on exactly one team at a
    // time, but everything above operates per-team in isolation, so it can't
    // see that a player who looks "current" here is ALSO current somewhere
    // else. Confirmed against real data this happens two ways: (1) a team
    // goes fully dark in our data (no more games at all -- e.g. Ultra Prime's
    // last recorded game was months before Hena/Ceos's confirmed transfer to
    // paiN Gaming) so its last known lineup never gets a closing event; (2) a
    // sub appearance at an old team (e.g. Sharvel filling in at Dplus Kia)
    // simply has no mechanism to close once that player becomes a different
    // team's primary. Rather than chase every such staleness scenario
    // individually, enforce the invariant directly: among a player's
    // still-open rows, only the one with the most recent start_date is
    // genuinely current -- close the rest as of that date.
    await client.query(`
      WITH open_rows AS (
        SELECT id, player_id, start_date,
               ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY start_date DESC, id DESC) AS rn,
               FIRST_VALUE(start_date) OVER (PARTITION BY player_id ORDER BY start_date DESC, id DESC) AS latest_start
        FROM roster_memberships
        WHERE end_date IS NULL
      )
      UPDATE roster_memberships rm
      SET end_date = open_rows.latest_start
      FROM open_rows
      WHERE rm.id = open_rows.id AND open_rows.rn > 1
    `);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return inserted;
}

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
    // OE leaves these null for some games; a missing share is not a zero share,
    // so fall back to the role-neutral 0.2 (one fifth of the team) rather than
    // letting a gap read as a terrible game.
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

/**
 * Season player rating: each player's recency-weighted per-game stats (KDA,
 * gold share, damage share, kill participation -- using OE's own precomputed
 * earnedgoldshare/damageshare columns -- plus win rate) percentiled against
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
 * output (the same footgun that made the OE and Liquipedia roster populators
 * clobber each other).
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

/** Populates player_game_performance from game_lineups + a per-game stats source (OE CSV rows, joined by caller). */
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
}

export async function upsertPlayerGamePerformance(pool: Pool, input: PlayerGamePerformanceInput): Promise<void> {
  await pool.query(
    `INSERT INTO player_game_performance (game_id, player_id, team_id, role, kills, deaths, assists, gold, damage_to_champions, gold_share, damage_share, kill_participation)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (game_id, player_id) DO UPDATE SET
       kills = EXCLUDED.kills, deaths = EXCLUDED.deaths, assists = EXCLUDED.assists,
       gold = EXCLUDED.gold, damage_to_champions = EXCLUDED.damage_to_champions,
       gold_share = EXCLUDED.gold_share, damage_share = EXCLUDED.damage_share, kill_participation = EXCLUDED.kill_participation`,
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
    ],
  );
}
