import type { Pool } from 'pg';
import type { LiquipediaGamePlayer } from './liquipediaApi.js';
import { fetchMatches } from './liquipediaApi.js';
import { resolvePosition, ourNameToLiquipediaName, HISTORICAL_LIQUIPEDIA_NAME_ALIASES } from './liquipediaMappings.js';
import { upsertPlayer, upsertTournament, upsertSeries, upsertGame, ensureTeamLeagueMembership } from './upsert.js';
import type { PlayerGamePerformanceInput } from './computePlayerRatings.js';
import { bulkInsert, dedupeByKey } from './bulkInsert.js';

// Liquipedia's `series` field identifies each Riot-official regional league.
// Non-official events (EWC, KeSPA Cup) are excluded just by not appearing here
// or in INTERNATIONAL_SERIES.
export const REGIONAL_SERIES_TO_LEAGUE_SLUG: Record<string, string> = {
  'LoL Champions Korea': 'LCK',
  'LoL Pro League': 'LPL',
  LEC: 'LEC',
  LCS: 'LCS',
  CBLOL: 'CBLOL',
  'LoL Championship Pacific': 'LCP',
};

// Each confirmed against the API via a real match from that event.
export const INTERNATIONAL_SERIES = new Set(['Mid-Season Invitational', 'World Championships', 'First Stand Tournament']);

// Through 2025 the Americas ran as one series split into North (LCS) and South
// (CBLOL) conferences. Series alone can't tell them apart, so the conference is
// read off `parent` ("LTA/2025/Split_2/North").
export const AMERICAS_SERIES = 'LoL Championship of The Americas';
const AMERICAS_CONFERENCE_TO_LEAGUE_SLUG: Record<string, string> = { North: 'LCS', South: 'CBLOL' };

export interface MatchClassification {
  tournamentType: 'regional_split' | 'international';
  canonicalLeagueId: number | null; // set only for regional -- international tournaments aren't tied to one league
  isInternational: boolean;
}

/**
 * Promotion and relegation play, which is not part of a league's season.
 *
 * Matched on the page path, because neither tier nor tiertype separates it:
 * LCP 2026 Promotion is tier 1 Qualifier, LCP's Wild Card Playoffs are tier 2
 * with no tiertype, and LPL's Regional Finals -- which ARE that league's
 * playoffs and must stay -- are tier 2 with no tiertype too. The path is the
 * one field that tells them apart: `LCP/2026/Promotion`,
 * `LCP/2027/Promotion/Wild_Card_Playoffs/...` and `LTA/2026/North/
 * Promotion_Tournament` against `LPL/2025/Regional_Finals`.
 *
 * A whole segment, anchored: a league called "Promotional League" would not be
 * promotion play, and `Regional_Finals` must never match.
 */
const PROMOTION_SEGMENT = /(^|\/)Promotion(_[A-Za-z]+)?(\/|$)/;

export function isPromotionPlay(parent: string): boolean {
  return PROMOTION_SEGMENT.test(parent);
}

/**
 * Extra LPDB conditions per series, ANDed onto the pull's date window.
 *
 * `classifyMatch` is what guarantees promotion play never lands; this only
 * stops us fetching it. LCP earns one because its series bucket carries the
 * whole open-qualifier tier -- 82 of the 84 matches in a daily window, and 224
 * of 247 over a month.
 *
 * NOT global. `tiertype=Qualifier` is also what MSI's regional qualifier
 * brackets carry, and those are games we rate.
 */
export const SERIES_EXTRA_CONDITIONS: Record<string, string> = {
  'LoL Championship Pacific': '[[liquipediatiertype::!Qualifier]]',
};

/**
 * Classifies a match's series+parent for ingestion, or null to exclude.
 * Exclusion is the default, so an unrecognized series never sneaks in. Regional
 * MSI-qualifier brackets share the "Mid-Season Invitational" series with the
 * real MSI, so `parent` is checked too (see the Road_to_ guard below).
 */
export function classifyMatch(series: string, parent: string, leagueIdBySlug: Map<string, number>): MatchClassification | null {
  // Before anything else: a promotion bracket is a league team playing an
  // outsider for a slot, not a season game, and it moved two LCP ratings.
  if (isPromotionPlay(parent)) return null;

  const leagueSlug = REGIONAL_SERIES_TO_LEAGUE_SLUG[series];
  if (leagueSlug) {
    const canonicalLeagueId = leagueIdBySlug.get(leagueSlug);
    if (!canonicalLeagueId) return null;
    return { tournamentType: 'regional_split', canonicalLeagueId, isInternational: false };
  }
  if (series === AMERICAS_SERIES) {
    // Cross-Conference and Championship brackets (North vs South = LCS vs CBLOL)
    // belong to neither regional league, so they're excluded until they have a home.
    const conference = /\/(North|South)$/.exec(parent)?.[1];
    if (!conference) return null;
    const canonicalLeagueId = leagueIdBySlug.get(AMERICAS_CONFERENCE_TO_LEAGUE_SLUG[conference]);
    if (!canonicalLeagueId) return null;
    return { tournamentType: 'regional_split', canonicalLeagueId, isInternational: false };
  }
  if (INTERNATIONAL_SERIES.has(series)) {
    // A "Road to X" bracket is regional qualifying play (e.g. LCK's Road to MSI
    // is their spring playoff), so route it to the league named in the parent
    // rather than the international event. Untracked leagues still drop out.
    const roadTo = /^([A-Za-z]+)\/\d+\/Road_to_/.exec(parent);
    if (roadTo) {
      const canonicalLeagueId = leagueIdBySlug.get(roadTo[1]);
      return canonicalLeagueId ? { tournamentType: 'regional_split', canonicalLeagueId, isInternational: false } : null;
    }
    return { tournamentType: 'international', canonicalLeagueId: null, isInternational: true };
  }
  return null;
}

/**
 * The tournament a match belongs to. Normally one per Liquipedia `parent`, but
 * the LCK has no splits: its single-row season is broken into Spring (Sp2 weeks
 * + the Road to MSI spring playoff) and Summer (Sp3 weeks + play-in + playoffs),
 * matching how every other region is chunked -- the regional play before each
 * international. The Sp2/Sp3 marker in the bracket id decides the half.
 */
export function resolveTournament(match: { parent: string; tournament: string; match2bracketid: string }): { overviewPage: string; name: string } {
  const season = /^LCK\/(\d{4})$/.exec(match.parent);
  if (season) {
    const half = /Sp2/.test(match.match2bracketid) ? 'Spring' : 'Summer';
    return { overviewPage: `liquipedia:LCK/${season[1]}/${half}`, name: `LCK ${season[1]} ${half}` };
  }
  const roadToMsi = /^LCK\/(\d{4})\/Road_to_MSI$/.exec(match.parent);
  if (roadToMsi) {
    return { overviewPage: `liquipedia:LCK/${roadToMsi[1]}/Spring`, name: `LCK ${roadToMsi[1]} Spring` };
  }
  return { overviewPage: `liquipedia:${match.parent}`, name: match.tournament };
}

function parseLengthToSeconds(length: string): number | null {
  const match = /^(\d+):(\d{2})$/.exec((length ?? '').trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * A Bo3/Bo5 that ends early still returns a full-length match2games array;
 * unplayed slots come back `scores: [0,0]`, `winner: ""`, `length: ""`. Those
 * placeholders still carry a `players` list, so only a decisive score marks a
 * game played. Load-bearing: without it every unplayed slot is credited to
 * team2, which was ~31% of the dataset as phantom games.
 */
export function isPlayedGame(game: { winner?: string; opponents: { score: number }[] }): boolean {
  if (game.opponents.length !== 2) return false;
  const [a, b] = game.opponents;
  const decisiveByScore = (a.score === 1) !== (b.score === 1);
  if (!decisiveByScore) return false;
  // `winner` is the explicit signal when present; treat "" as unplayed.
  if (game.winner !== undefined && game.winner !== '1' && game.winner !== '2') return false;
  return true;
}

const ROLES_PER_SIDE = 5;

/**
 * Whether a game carries a full stat line for all ten players.
 *
 * Liquipedia publishes the result before the per-player stats on some rows: 13
 * games across LCS and LPL on 2026-08-16 arrived with scores and an empty
 * players list. Ingesting one writes a game that moves team ratings while
 * contributing nothing to player ratings -- and team ratings read player
 * ratings back through the roster prior, so the two silently drift apart.
 *
 * Whether to wait for them is shouldWaitForStats's call, not this one's.
 */
export function hasCompletePlayerData(game: { opponents: { players?: { role: string }[] }[] }): boolean {
  if (game.opponents.length !== 2) return false;
  return game.opponents.every((side) => {
    const roles = new Set((side.players ?? []).map((player) => resolvePosition(player.role)).filter(Boolean));
    return roles.size === ROLES_PER_SIDE;
  });
}

/**
 * How long a played game waits for its stat lines before being ingested anyway.
 *
 * Waiting forever is not an option: Liquipedia never published player data for
 * **51.8% of LPL 2024, 40.6% of 2025 and 12.3% of 2026** (821 of 6,724 games
 * overall, almost all LPL). Holding those out would discard half a league's
 * real results to protect a consistency they can never satisfy.
 *
 * So the wait covers the case that is actually recoverable -- a result
 * published minutes before its stat lines -- and then gives up. Two days
 * matches STAGE_STALL_DAYS, so a board is never held on a game that ingestion
 * has already stopped waiting for.
 */
export const STATS_GRACE_DAYS = 2;

/** True while a played game may still have its stat lines filled in. */
export function shouldWaitForStats(
  game: { opponents: { players?: { role: string }[] }[] },
  matchDate: string,
  now: Date,
): boolean {
  if (hasCompletePlayerData(game)) return false;
  const playedAt = Date.parse(`${matchDate.replace(' ', 'T')}Z`);
  if (Number.isNaN(playedAt)) return false;
  return now.getTime() - playedAt < STATS_GRACE_DAYS * 86_400_000;
}

/**
 * Gold by role for one side, for the lane differential. A role is omitted when
 * it doesn't resolve to exactly one player -- missing or ambiguous both yield a
 * null differential rather than a guess.
 */
export function goldByRole(players: LiquipediaGamePlayer[]): Map<string, number> {
  const gold = new Map<string, number>();
  const ambiguous = new Set<string>();

  for (const player of players) {
    const role = resolvePosition(player.role);
    if (!role) continue;
    if (gold.has(role)) {
      ambiguous.add(role);
      continue;
    }
    gold.set(role, player.gold ?? 0);
  }

  for (const role of ambiguous) gold.delete(role);
  return gold;
}

export interface MatchIngestResult {
  seriesProcessed: number;
  seriesSkipped: number;
  gamesProcessed: number;
  /** Unplayed placeholder slots in early-ending series -- see isPlayedGame. */
  gamesSkippedUnplayed: number;
  /** Played, but the stat lines may still be published -- held for a later run. */
  gamesSkippedIncomplete: number;
  /** Ingested past the grace period with stat lines that never came; player ratings will not see them. */
  gamesIngestedWithoutStats: number;
  /** Games where two players on one side resolved to the same id, so one stat line overwrote another. */
  gamesWithCollidedPlayers: number;
  teamsUnresolved: string[];
}

/**
 * Ingests Liquipedia match/series data into the
 * games/series/tournaments/game_lineups/player_game_performance schema.
 * Idempotent on the unique keys, so re-running is safe. `conditions` is the
 * caller's full Liquipedia filter (date range + `[[series::X]]`).
 */
export async function ingestLiquipediaMatches(pool: Pool, conditions: string): Promise<MatchIngestResult> {
  const matches = await fetchMatches(conditions);

  const ourTeams = await pool.query<{ id: number; name: string }>('SELECT id, name FROM teams');
  // Case-insensitive: Liquipedia's casing differs from ours ("PaiN" vs "paiN").
  const teamIdByLiquipediaName = new Map<string, number>();
  const teamIdByOurName = new Map(ourTeams.rows.map((t) => [t.name, t.id]));
  for (const team of ourTeams.rows) teamIdByLiquipediaName.set(ourNameToLiquipediaName(team.name).toLowerCase(), team.id);
  // Also register historical/pre-sponsor names -- see HISTORICAL_LIQUIPEDIA_NAME_ALIASES.
  for (const [historicalName, ourName] of Object.entries(HISTORICAL_LIQUIPEDIA_NAME_ALIASES)) {
    const teamId = teamIdByOurName.get(ourName);
    if (teamId) teamIdByLiquipediaName.set(historicalName.toLowerCase(), teamId);
  }

  const leaguesResult = await pool.query<{ id: number; slug: string }>('SELECT id, slug FROM leagues');
  const leagueIdBySlug = new Map(leaguesResult.rows.map((l) => [l.slug, l.id]));

  const result: MatchIngestResult = {
    seriesProcessed: 0,
    seriesSkipped: 0,
    gamesProcessed: 0,
    gamesSkippedUnplayed: 0,
    gamesSkippedIncomplete: 0,
    gamesIngestedWithoutStats: 0,
    gamesWithCollidedPlayers: 0,
    teamsUnresolved: [],
  };
  // Pinned once so every game in a run is judged against the same clock.
  const now = new Date();
  const pending: PendingWrites = { lineups: [], performances: [], keep: [] };
  const teamsUnresolvedSet = new Set<string>();
  const playerIdCache = new Map<string, number>(); // Liquipedia's disambiguated player key -> our player_id
  const tournamentIdByOverview = new Map<string, number>();

  for (const match of matches) {
    const classification = classifyMatch(match.series, match.parent, leagueIdBySlug);
    if (!classification || match.match2opponents.length !== 2 || match.match2games.length === 0) {
      result.seriesSkipped += 1;
      continue; // not Riot-official, a regional MSI-qualifier bracket, or malformed
    }

    const [opp1, opp2] = match.match2opponents;
    const team1Id = teamIdByLiquipediaName.get(opp1.name.toLowerCase());
    const team2Id = teamIdByLiquipediaName.get(opp2.name.toLowerCase());
    if (!team1Id || !team2Id) {
      // A team outside our 6-league scope doesn't resolve, so its games are
      // excluded rather than mis-attributed.
      if (!team1Id) teamsUnresolvedSet.add(opp1.name);
      if (!team2Id) teamsUnresolvedSet.add(opp2.name);
      result.seriesSkipped += 1;
      continue;
    }

    const dateOnly = match.date.slice(0, 10);
    // A team's league follows games it has PLAYED, never a fixture. The pull
    // reaches 21 days forward, so acting on a scheduled match would close a
    // membership with a future end_date and open another before the team had
    // played a single game there -- and a cancelled or re-seeded fixture leaves
    // no way back, since team_league_memberships has no rollback path.
    const played = match.match2games.some((game) => isPlayedGame(game));
    // International passes must NOT touch team_league_memberships -- a
    // team's home region comes exclusively from its regional-split games.
    if (played && classification.tournamentType === 'regional_split' && classification.canonicalLeagueId) {
      await ensureTeamLeagueMembership(pool, { teamId: team1Id, leagueId: classification.canonicalLeagueId, asOfDate: dateOnly });
      await ensureTeamLeagueMembership(pool, { teamId: team2Id, leagueId: classification.canonicalLeagueId, asOfDate: dateOnly });
    }

    const { overviewPage, name } = resolveTournament(match);
    let tournamentId = tournamentIdByOverview.get(overviewPage);
    if (!tournamentId) {
      tournamentId = await upsertTournament(pool, {
        overviewPage,
        name,
        rawLeagueName: match.series,
        canonicalLeagueId: classification.canonicalLeagueId,
        tournamentType: classification.tournamentType,
        dateStart: dateOnly,
        dateEnd: null,
      });
      tournamentIdByOverview.set(overviewPage, tournamentId);
    }

    const team1Score = opp1.score ?? 0;
    const team2Score = opp2.score ?? 0;
    // Null unless played and decided. Liquipedia reports a scheduled match as
    // -1 to -1; the old `>=` gave every one of those (and every drawn Bo2) to
    // team1. See db/migrations/0010.
    const seriesDecided = team1Score >= 0 && team2Score >= 0 && team1Score !== team2Score;
    let winnerTeamId: number | null = null;
    if (seriesDecided) winnerTeamId = team1Score > team2Score ? team1Id : team2Id;
    const seriesId = await upsertSeries(pool, {
      tournamentId,
      leaguepediaMatchId: `liquipedia:${match.match2id}`,
      team1Id,
      team2Id,
      bestOf: match.bestof ?? null,
      team1Score,
      team2Score,
      winnerTeamId,
      isInternational: classification.isInternational,
      bracketId: match.match2bracketid || null,
      // Same parse as the games take, so the two can never disagree by a zone.
      dateUtc: match.date ? match.date.replace(' ', 'T') + 'Z' : null,
      stageName: match.section || null,
    });
    result.seriesProcessed += 1;

    for (const [gameIndex, game] of match.match2games.entries()) {
      if (!isPlayedGame(game)) {
        result.gamesSkippedUnplayed += 1;
        continue;
      }
      // A result whose stat lines may still arrive waits for them, so team and
      // player ratings do not drift apart over a publication lag. Past the
      // grace period the result is taken as-is -- see STATS_GRACE_DAYS.
      if (shouldWaitForStats(game, match.date, now)) {
        result.gamesSkippedIncomplete += 1;
        continue;
      }
      if (!hasCompletePlayerData(game)) result.gamesIngestedWithoutStats += 1;
      const [gameOpp1, gameOpp2] = game.opponents;
      const gameWinnerTeamId = gameOpp1.score === 1 ? team1Id : team2Id;
      const gamelengthSeconds = parseLengthToSeconds(game.length);

      // Neutral epics only (dragons/barons/heralds/grubs/atakhans); null when the
      // side carries no stats. The jungle objective-control share is derived from these.
      const neutralObjectives = (o: typeof gameOpp1): number | null =>
        o.stats
          ? (o.stats.dragons ?? 0) + (o.stats.barons ?? 0) + (o.stats.heralds ?? 0) + (o.stats.grubs ?? 0) + (o.stats.atakhans ?? 0)
          : null;

      const gameId = await upsertGame(pool, {
        seriesId,
        leaguepediaUniqueLine: `liquipedia:${match.match2id}_${game.match2gameid}`,
        gameNumber: gameIndex + 1,
        team1Id,
        team2Id,
        winnerTeamId: gameWinnerTeamId,
        datetimeUtc: match.date.replace(' ', 'T') + 'Z', // no per-game timestamps; series date shared across games
        patch: null,
        team1Gold: gameOpp1.stats?.gold ?? null,
        team2Gold: gameOpp2.stats?.gold ?? null,
        gamelengthSeconds,
        team1NeutralObjectives: neutralObjectives(gameOpp1),
        team2NeutralObjectives: neutralObjectives(gameOpp2),
      });
      result.gamesProcessed += 1;

      // Everyone written this run; rows for anyone no longer listed are cleared
      // afterwards -- see pruneStalePerformance.
      const playersInGame = new Set<number>();
      // Roles written per side, so the prune can tell a lineup CORRECTION from a
      // partial fetch. Only a game we saw whole may have rows deleted from it.
      const rolesPerSide: number[] = [];

      for (const [opponentIndex, gameOpponent] of [gameOpp1, gameOpp2].entries()) {
        const teamId = opponentIndex === 0 ? team1Id : team2Id;
        const teamDamageTotal = gameOpponent.players.reduce((sum, p) => sum + (p.damagedone ?? 0), 0);
        const opponentGold = goldByRole((opponentIndex === 0 ? gameOpp2 : gameOpp1).players);
        let rolesWritten = 0;
        const idsThisSide = new Set<number>();

        for (const player of gameOpponent.players) {
          const role = resolvePosition(player.role);
          if (!role) continue;
          const facingGold = opponentGold.get(role);

          const playerId = await resolvePlayerId(pool, player, playerIdCache);
          playersInGame.add(playerId);
          idsThisSide.add(playerId);
          rolesWritten += 1;
          pending.lineups.push({ gameId, teamId, playerId, role });
          pending.performances.push({
            gameId,
            playerId,
            teamId,
            role,
            kills: player.kills ?? 0,
            deaths: player.deaths ?? 0,
            assists: player.assists ?? 0,
            gold: player.gold ?? 0,
            damageToChampions: player.damagedone ?? 0,
            goldShare: gameOpponent.stats?.gold ? (player.gold ?? 0) / gameOpponent.stats.gold : null,
            damageShare: teamDamageTotal > 0 ? (player.damagedone ?? 0) / teamDamageTotal : null,
            killParticipation: player.killparticipation ?? null,
            creepScore: player.creepscore ?? null,
            goldDiff: facingGold === undefined ? null : (player.gold ?? 0) - facingGold,
          });
        }

        // Two players on one side collapsing to one id is a handle collision
        // past resolvePlayerId -- one stat line overwrote another. Rare, but
        // reported rather than swallowed.
        if (idsThisSide.size < rolesWritten) result.gamesWithCollidedPlayers += 1;
        rolesPerSide.push(rolesWritten);
      }

      // Offer this game to the prune ONLY if both sides came back whole. A
      // partial fetch -- one side populated, the other empty, which Liquipedia
      // does return -- would otherwise delete the complete side's existing rows
      // as "no longer listed". Re-ingesting must never narrow what we hold.
      if (rolesPerSide.length === 2 && rolesPerSide.every((n) => n === ROLES_PER_SIDE)) {
        for (const playerId of playersInGame) pending.keep.push({ gameId, playerId });
      }
      if (pending.performances.length >= FLUSH_ROWS) await flushPending(pool, pending);
    }
  }
  await flushPending(pool, pending);

  result.teamsUnresolved = [...teamsUnresolvedSet];
  return result;
}

/**
 * Drops performance rows for players the current response no longer lists.
 * game_lineups is keyed on a slot (game, team, role), so a corrected lineup
 * replaces the occupant; player_game_performance is keyed on the person (game,
 * player), so a replaced player's row otherwise survives -- 180 phantom stat
 * lines fed ratings as real games before this.
 */
/**
 * Lineup and performance rows waiting to be written, and which (game, player)
 * pairs should survive the prune.
 *
 * Written a batch at a time rather than a row at a time. Per player this was
 * two statements plus a prune per game -- about 21 round trips a game, and
 * ~1s each against a hosted database, which made ingestion the slowest part of
 * the daily job by a distance. The statements were never the cost; the trips
 * were, exactly as with the rating writes.
 */
interface PendingWrites {
  lineups: { gameId: number; teamId: number; playerId: number; role: 'TOP' | 'JNG' | 'MID' | 'BOT' | 'SUP' }[];
  performances: PlayerGamePerformanceInput[];
  keep: { gameId: number; playerId: number }[];
}

const FLUSH_ROWS = 2000;

async function flushPending(pool: Pool, pending: PendingWrites): Promise<void> {
  if (pending.performances.length === 0 && pending.lineups.length === 0) return;

  // Deduplicated on the conflict key: one statement may not touch a key twice,
  // and two handles can resolve to one player id. Last wins, as a sequence of
  // individual upserts would have left it.
  const lineups = dedupeByKey(pending.lineups, (row) => `${row.gameId}:${row.teamId}:${row.role}`);
  const performances = dedupeByKey(pending.performances, (row) => `${row.gameId}:${row.playerId}`);

  await bulkInsert(
    pool,
    'game_lineups',
    ['game_id', 'team_id', 'player_id', 'role'],
    lineups.map((row) => [row.gameId, row.teamId, row.playerId, row.role]),
    'ON CONFLICT (game_id, team_id, role) DO UPDATE SET player_id = EXCLUDED.player_id',
  );

  await bulkInsert(
    pool,
    'player_game_performance',
    [
      'game_id', 'player_id', 'team_id', 'role', 'kills', 'deaths', 'assists', 'gold',
      'damage_to_champions', 'gold_share', 'damage_share', 'kill_participation', 'creep_score', 'gold_diff',
    ],
    performances.map((row) => [
      row.gameId, row.playerId, row.teamId, row.role, row.kills, row.deaths, row.assists, row.gold,
      row.damageToChampions, row.goldShare, row.damageShare, row.killParticipation, row.creepScore, row.goldDiff,
    ]),
    `ON CONFLICT (game_id, player_id) DO UPDATE SET
       kills = EXCLUDED.kills, deaths = EXCLUDED.deaths, assists = EXCLUDED.assists,
       gold = EXCLUDED.gold, damage_to_champions = EXCLUDED.damage_to_champions,
       gold_share = EXCLUDED.gold_share, damage_share = EXCLUDED.damage_share,
       kill_participation = EXCLUDED.kill_participation, creep_score = EXCLUDED.creep_score,
       gold_diff = EXCLUDED.gold_diff`,
  );

  await pruneStalePerformance(pool, pending.keep);

  pending.lineups.length = 0;
  pending.performances.length = 0;
  pending.keep.length = 0;
}

/**
 * Clears performance rows for players no longer listed in a game -- a lineup
 * correction on Liquipedia's side. One statement for the whole batch: the pairs
 * that should survive are unnested and anything else in those games goes.
 */
async function pruneStalePerformance(pool: Pool, keep: { gameId: number; playerId: number }[]): Promise<void> {
  if (keep.length === 0) return;
  const gameIds = keep.map((k) => k.gameId);
  const playerIds = keep.map((k) => k.playerId);
  await pool.query(
    `DELETE FROM player_game_performance p
      WHERE p.game_id = ANY($1::int[])
        AND NOT EXISTS (
          SELECT 1 FROM unnest($1::int[], $2::int[]) AS keep(game_id, player_id)
          WHERE keep.game_id = p.game_id AND keep.player_id = p.player_id
        )`,
    [gameIds, playerIds],
  );
}

// Matches existing players by handle; creates new ones keyed by Liquipedia's
// disambiguated identity, not the handle, so two different people sharing a
// handle (real data's "Saber") aren't merged.
async function resolvePlayerId(pool: Pool, player: LiquipediaGamePlayer, cache: Map<string, number>): Promise<number> {
  const cached = cache.get(player.player);
  if (cached) return cached;

  const lookup = await pool.query<{ id: number }>(`SELECT id FROM players WHERE lower(handle) = lower($1) LIMIT 1`, [player.displayName]);
  let playerId: number;
  if (lookup.rows.length > 0) {
    playerId = lookup.rows[0].id;
  } else {
    playerId = await upsertPlayer(pool, { leaguepediaPage: `liquipedia:player:${player.player}`, handle: player.displayName });
  }
  cache.set(player.player, playerId);
  return playerId;
}
