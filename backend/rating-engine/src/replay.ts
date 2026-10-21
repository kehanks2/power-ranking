/**
 * Replays a full game history through the rating engine, period by period. No
 * DB or network: a pure function of (games + decay events + config), so a full
 * replay from period 1 is always a safe recovery path. A thin caller loads from
 * Postgres and persists the returned history rows.
 */

import { updateRating, g, E, DEFAULT_TAU, SIGMA_REFERENCE_DAYS, type RatingState, type GameResult } from './glicko2.js';
import {
  updateLeagueMeta,
  effectiveMetaWeight,
  internationalEvidenceShrink,
  DEFAULT_META_WEIGHT,
  type InternationalGameResult,
} from './contextualMeta.js';
import { applyCoincidentDecay, DEFAULT_PRIOR_CONFIDENCE_RELIEF, type RosterDecayConfig } from './decay.js';
import { computeMovWeight } from './movWeight.js';

export interface ReplayGame {
  gameId: string;
  datetimeUtc: string; // ISO datetime
  team1Id: string;
  team2Id: string;
  winnerTeamId: string;
  team1LeagueId: string;
  team2LeagueId: string;
  team1Gold: number | null;
  team2Gold: number | null;
  gamelengthSeconds: number | null;
  /** Which series this game belongs to; absent (test fixtures) = its own series. */
  seriesId?: string;
  // Played at an international event -- distinct from cross-region (two LPL sides
  // at Worlds). League-meta uses the cross-region test; the international board
  // uses this flag.
  internationalEvent?: boolean;
  /** Played in an international event's play-in stage. */
  playIn?: boolean;
}

/** A roster-change decay event, already resolved by the caller (turnover + roster-implied prior). */
export interface RosterDecayEvent {
  kind: 'roster_change';
  teamId: string;
  effectiveDate: string; // ISO date
  turnover: number;
  rosterImpliedMu: number;
  /** Mean confidence (0-1) of the incoming players' ratings; absent = full RD reset. */
  rosterImpliedConfidence?: number;
}

/** A split-boundary seasonal decay event, already resolved by the caller (league mean at that date). */
export interface SeasonalDecayEvent {
  kind: 'seasonal';
  teamId: string;
  effectiveDate: string; // ISO date
  leagueMeanMu: number;
  kSeason: number;
}

export type DecayEvent = RosterDecayEvent | SeasonalDecayEvent;

export interface ReplayConfig {
  phiInitMax: number;
  sigmaDefault: number;
  marginScale: number;
  movWeightCap: number;
  /** See contextualMeta.ts's DEFAULT_META_WEIGHT for why this exists and defaults to 1.0. */
  metaWeight?: number;
  /** Intra-series correlation (rho), 0..1 -- see seriesEvidenceWeight. Default 0. */
  seriesCorrelation?: number;
  /** Glicko-2's tau: how fast volatility can change (Glickman suggests 0.3-1.2). */
  tau?: number;
  // Rating-period length in days. Every game in a period is graded against the
  // ratings at its start.
  ratingPeriodDays?: number;
  /** See DEFAULT_PRIOR_CONFIDENCE_RELIEF -- how much a confident roster prior damps RD widening. */
  priorConfidenceRelief?: number;
  /** Extra weight on international games in the contextual update (1 = none). */
  internationalWeightMultiplier?: number;
  /** Weight on a play-in game relative to any other international game (1 = none). */
  playInWeight?: number;
  /** Half-life for down-weighting older games. Omitted/Infinity = none (production). */
  recencyHalfLifeDays?: number;
  /** Date recency is measured from. Defaults to the latest game in the input. */
  recencyReferenceDate?: string;
  /**
   * Starting phi of a per-team international deviation: a third term, moved only
   * by cross-region games, so a team's international form is not washed out by
   * its regional games. Omitted = no such term (production).
   */
  teamInternationalPhiInit?: number;
  /** With the term above: whether cross-region games still move contextual. Default true. */
  contextualLearnsInternational?: boolean;
  /**
   * Fades a team's league term as it plays cross-region games: weight x
   * h / (h + games). Omitted = no fade (production).
   */
  metaShrinkHalfLifeGames?: number;
  /**
   * Half-life over which the international deviation's mean decays toward 0.
   * Glicko-2 only widens phi with time; it never moves mu, so without this an
   * old result keeps its full weight in the point estimate.
   */
  teamInternationalHalfLifeDays?: number;
  /** Shrinks the international deviation by a roster change's turnover and widens its phi to match. */
  teamInternationalRosterReset?: boolean;
}

/**
 * Games inside a Bo3/Bo5 aren't independent, but Glicko-2 assumes they are, so a
 * 3-0 counted as three wins shrinks phi too fast (overconfidence). Design-effect
 * correction: each of n correlated observations carries weight 1 / (1 + (n-1)*rho).
 * rho 0 -> weight 1; rho 1 -> a whole series counts once. rho is tuned/backtested.
 */
export function seriesEvidenceWeight(gamesInSeries: number, seriesCorrelation: number): number {
  if (seriesCorrelation <= 0 || gamesInSeries <= 1) return 1;
  const rho = Math.min(1, seriesCorrelation);
  return 1 / (1 + (gamesInSeries - 1) * rho);
}

export interface ReplayInput {
  teamIds: string[];
  leagueIds: string[];
  games: ReplayGame[];
  decayEvents: DecayEvent[];
  config: ReplayConfig;
  /**
   * Per-team starting contextual rating, instead of the cold phiInitMax start.
   * Used by the international board to seed each team from its roster's
   * international player ratings, so a thin team is not a total unknown.
   */
  initialTeamStates?: Map<string, RatingState>;
}

export interface TeamRatingSnapshot {
  teamId: string;
  asOfDate: string;
  mu: number;
  phi: number;
  sigma: number;
  reason: 'initial' | 'game_update' | 'roster_decay' | 'seasonal_decay';
  rosterImpliedMu?: number;
}

export interface LeagueRatingSnapshot {
  leagueId: string;
  asOfDate: string;
  mu: number;
  phi: number;
  sigma: number;
}

export interface ReplayResult {
  teamHistory: TeamRatingSnapshot[];
  leagueHistory: LeagueRatingSnapshot[];
  /** Only when `teamInternationalPhiInit` is set; one row per team per period it played cross-region. */
  teamInternationalHistory?: TeamRatingSnapshot[];
  /**
   * Only when `teamInternationalPhiInit` is set: contextual + faded league term +
   * international deviation, per team, for every period any of the three moved,
   * and for every team on the final period.
   */
  combinedHistory?: TeamRatingSnapshot[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_RATING_PERIOD_DAYS = 7;

function periodBucket(dateIso: string, periodDays: number): string {
  const periodMs = periodDays * MS_PER_DAY;
  const epochPeriod = Math.floor(new Date(dateIso).getTime() / periodMs);
  return new Date(epochPeriod * periodMs).toISOString().slice(0, 10);
}

/** Glicko's game step with no volatility and no time drift: for a term whose time behaviour is mean-reverting. */
function updateWithoutDrift(current: RatingState, games: GameResult[]): RatingState {
  if (games.length === 0) return current;
  let vInverse = 0;
  let deltaSum = 0;
  for (const game of games) {
    const weight = game.weight ?? 1;
    const gPhi = g(game.opponent.phi);
    const expected = E(game.ownExpectancyMu ?? current.mu, game.opponent.mu, game.opponent.phi);
    vInverse += weight * gPhi * gPhi * expected * (1 - expected);
    deltaSum += weight * gPhi * (game.score - expected);
  }
  const phi = 1 / Math.sqrt(1 / (current.phi * current.phi) + vInverse);
  return { mu: current.mu + phi * phi * deltaSum, phi, sigma: current.sigma };
}

function movWeightForGame(game: ReplayGame, config: ReplayConfig): number {
  if (game.team1Gold === null || game.team2Gold === null || !game.gamelengthSeconds) return 1;
  return computeMovWeight(
    { team1Gold: game.team1Gold, team2Gold: game.team2Gold, gamelengthSeconds: game.gamelengthSeconds },
    config.marginScale,
    config.movWeightCap,
  );
}

export function runReplay(input: ReplayInput): ReplayResult {
  // Series sizes counted across the whole input, so the correction holds even if
  // a series straddles two periods.
  const gamesPerSeries = new Map<string, number>();
  for (const game of input.games) {
    if (game.seriesId === undefined) continue;
    gamesPerSeries.set(game.seriesId, (gamesPerSeries.get(game.seriesId) ?? 0) + 1);
  }
  const seriesCorrelation = input.config.seriesCorrelation ?? 0;
  const seriesWeightFor = (game: ReplayGame): number =>
    game.seriesId === undefined ? 1 : seriesEvidenceWeight(gamesPerSeries.get(game.seriesId) ?? 1, seriesCorrelation);

  const periodDays = input.config.ratingPeriodDays ?? DEFAULT_RATING_PERIOD_DAYS;

  const recencyHalfLife = input.config.recencyHalfLifeDays ?? Infinity;
  const recencyReference = Number.isFinite(recencyHalfLife)
    ? Date.parse(
        input.config.recencyReferenceDate ??
          input.games.reduce((latest, g) => (g.datetimeUtc > latest ? g.datetimeUtc : latest), input.games[0]?.datetimeUtc ?? ''),
      )
    : 0;
  const recencyWeightFor = (game: ReplayGame): number => {
    if (!Number.isFinite(recencyHalfLife)) return 1;
    const ageDays = Math.max(0, (recencyReference - Date.parse(game.datetimeUtc)) / MS_PER_DAY);
    return Math.pow(0.5, ageDays / recencyHalfLife);
  };

  const teamContextual = new Map<string, RatingState>();
  for (const teamId of input.teamIds) {
    const seed = input.initialTeamStates?.get(teamId);
    teamContextual.set(teamId, seed ? { ...seed } : { mu: 0, phi: input.config.phiInitMax, sigma: input.config.sigmaDefault });
  }
  const leagueMeta = new Map<string, RatingState>();
  for (const leagueId of input.leagueIds) {
    leagueMeta.set(leagueId, { mu: 0, phi: input.config.phiInitMax, sigma: input.config.sigmaDefault });
  }

  const teamInternationalPhiInit = input.config.teamInternationalPhiInit;
  const contextualLearnsInternational = teamInternationalPhiInit === undefined || (input.config.contextualLearnsInternational ?? true);
  const teamInternational = new Map<string, RatingState>();
  if (teamInternationalPhiInit !== undefined) {
    for (const teamId of input.teamIds) {
      teamInternational.set(teamId, { mu: 0, phi: teamInternationalPhiInit, sigma: input.config.sigmaDefault });
    }
  }
  const zeroDeviation: RatingState = { mu: 0, phi: 0, sigma: 0 };
  const teamInternationalHalfLifeDays = input.config.teamInternationalHalfLifeDays;
  const metaShrinkHalfLifeGames = input.config.metaShrinkHalfLifeGames;
  const crossRegionGamesPlayed = new Map<string, number>();
  const metaShrinkFor = (teamId: string): number =>
    metaShrinkHalfLifeGames === undefined
      ? 1
      : internationalEvidenceShrink(crossRegionGamesPlayed.get(teamId) ?? 0, metaShrinkHalfLifeGames);

  const teamHistory: TeamRatingSnapshot[] = [];
  const leagueHistory: LeagueRatingSnapshot[] = [];
  const teamInternationalHistory: TeamRatingSnapshot[] = [];
  const combinedHistory: TeamRatingSnapshot[] = [];
  const recordedContextual = new Map<string, RatingState>();
  const recordedMeta = new Map<string, RatingState>();
  // The league a team's league term comes from: the last tracked league it played under.
  const teamLeagueOf = new Map<string, string>();
  const earliestDate = input.games.length > 0 ? [...input.games].sort((a, b) => (a.datetimeUtc < b.datetimeUtc ? -1 : 1))[0].datetimeUtc.slice(0, 10) : new Date().toISOString().slice(0, 10);

  for (const teamId of input.teamIds) {
    const state = teamContextual.get(teamId)!;
    teamHistory.push({ teamId, asOfDate: earliestDate, mu: state.mu, phi: state.phi, sigma: state.sigma, reason: 'initial' });
    recordedContextual.set(teamId, state);
  }
  for (const leagueId of input.leagueIds) {
    const state = leagueMeta.get(leagueId)!;
    leagueHistory.push({ leagueId, asOfDate: earliestDate, mu: state.mu, phi: state.phi, sigma: state.sigma });
    recordedMeta.set(leagueId, state);
  }

  const gamesByPeriod = new Map<string, ReplayGame[]>();
  for (const game of input.games) {
    const period = periodBucket(game.datetimeUtc, periodDays);
    if (!gamesByPeriod.has(period)) gamesByPeriod.set(period, []);
    gamesByPeriod.get(period)!.push(game);
  }

  const decayByTeamAndPeriod = new Map<string, DecayEvent[]>();
  for (const event of input.decayEvents) {
    const key = `${event.teamId}::${periodBucket(event.effectiveDate, periodDays)}`;
    if (!decayByTeamAndPeriod.has(key)) decayByTeamAndPeriod.set(key, []);
    decayByTeamAndPeriod.get(key)!.push(event);
  }

  const allPeriods = new Set<string>([...gamesByPeriod.keys(), ...input.decayEvents.map((e) => periodBucket(e.effectiveDate, periodDays))]);
  const sortedPeriods = [...allPeriods].sort();
  const rosterConfig: RosterDecayConfig = { phiInitMax: input.config.phiInitMax, sigmaDefault: input.config.sigmaDefault };

  // Drift is a random walk: variance grows with elapsed TIME, not period count.
  // sortedPeriods holds only occupied periods, so elapsed time is measured from
  // the previous occupied one -- otherwise empty offseasons contribute no drift
  // and teams carry old certainty through exactly the gap where rosters churn.
  let previousPeriod: string | null = null;
  for (const period of sortedPeriods) {
    // Zero for the first period: teams already start at phiInitMax.
    const elapsedDays =
      previousPeriod === null ? 0 : (Date.parse(period) - Date.parse(previousPeriod)) / MS_PER_DAY;
    const elapsedPeriods = elapsedDays / SIGMA_REFERENCE_DAYS;
    previousPeriod = period;
    const touched = new Set<string>();

    // Mean-reverting: the mean decays toward 0 and the variance relaxes toward the
    // prior's, in place of Glicko's unbounded drift (see updateWithoutDrift).
    if (teamInternationalHalfLifeDays !== undefined && teamInternationalPhiInit !== undefined && elapsedDays > 0) {
      const retained = Math.pow(0.5, elapsedDays / teamInternationalHalfLifeDays);
      for (const [teamId, deviation] of teamInternational) {
        const variance = deviation.phi ** 2 * retained ** 2 + teamInternationalPhiInit ** 2 * (1 - retained ** 2);
        teamInternational.set(teamId, { ...deviation, mu: deviation.mu * retained, phi: Math.sqrt(variance) });
      }
    }

    // 1. Apply decay events dated in this period, before this period's games.
    for (const teamId of input.teamIds) {
      const events = decayByTeamAndPeriod.get(`${teamId}::${period}`);
      if (!events || events.length === 0) continue;
      touched.add(teamId);

      const rosterEvent = events.find((e): e is RosterDecayEvent => e.kind === 'roster_change');
      const seasonalEvent = events.find((e): e is SeasonalDecayEvent => e.kind === 'seasonal');
      const current = teamContextual.get(teamId)!;

      const deviation = teamInternational.get(teamId);
      if (rosterEvent && deviation && teamInternationalPhiInit !== undefined && input.config.teamInternationalRosterReset) {
        const reset = {
          ...deviation,
          mu: deviation.mu * (1 - rosterEvent.turnover),
          phi: deviation.phi + rosterEvent.turnover * Math.max(0, teamInternationalPhiInit - deviation.phi),
        };
        teamInternational.set(teamId, reset);
        teamInternationalHistory.push({ teamId, asOfDate: period, mu: reset.mu, phi: reset.phi, sigma: reset.sigma, reason: 'roster_decay' });
      }

      const updated = applyCoincidentDecay(
        current,
        rosterEvent
          ? {
              turnover: rosterEvent.turnover,
              rosterImpliedMu: rosterEvent.rosterImpliedMu,
              priorConfidence: rosterEvent.rosterImpliedConfidence,
            }
          : null,
        seasonalEvent ? { leagueMeanMu: seasonalEvent.leagueMeanMu, kSeason: seasonalEvent.kSeason } : null,
        rosterConfig,
        input.config.priorConfidenceRelief ?? DEFAULT_PRIOR_CONFIDENCE_RELIEF,
      );
      teamContextual.set(teamId, updated);

      const dominantReason: TeamRatingSnapshot['reason'] =
        rosterEvent && seasonalEvent
          ? Math.abs((rosterEvent.rosterImpliedMu - current.mu) * rosterEvent.turnover) >=
            Math.abs((seasonalEvent.leagueMeanMu - current.mu) * seasonalEvent.kSeason)
            ? 'roster_decay'
            : 'seasonal_decay'
          : rosterEvent
            ? 'roster_decay'
            : 'seasonal_decay';

      recordedContextual.set(teamId, updated);
      teamHistory.push({
        teamId,
        asOfDate: period,
        mu: updated.mu,
        phi: updated.phi,
        sigma: updated.sigma,
        reason: dominantReason,
        rosterImpliedMu: rosterEvent?.rosterImpliedMu,
      });
    }

    // 2. Both intra-league and international games feed a team's own contextual
    // rating; international games additionally feed league meta, so winning a
    // tournament moves the team's own rating, not just the league-wide meta.
    const periodGames = gamesByPeriod.get(period) ?? [];
    const ownContextualGamesByTeam = new Map<string, GameResult[]>();
    const ownDeviationGamesByTeam = new Map<string, GameResult[]>();
    const internationalGamesByLeague = new Map<string, InternationalGameResult[]>();

    for (const game of periodGames) {
      const isInternational = game.team1LeagueId !== game.team2LeagueId;
      const weight =
        movWeightForGame(game, input.config) *
        seriesWeightFor(game) *
        recencyWeightFor(game) *
        (isInternational ? (input.config.internationalWeightMultiplier ?? 1) : 1) *
        (game.playIn ? (input.config.playInWeight ?? 1) : 1);
      touched.add(game.team1Id);
      touched.add(game.team2Id);
      if (leagueMeta.has(game.team1LeagueId)) teamLeagueOf.set(game.team1Id, game.team1LeagueId);
      if (leagueMeta.has(game.team2LeagueId)) teamLeagueOf.set(game.team2Id, game.team2LeagueId);
      const team1Score = game.winnerTeamId === game.team1Id ? 1 : 0;
      const team1Contextual = teamContextual.get(game.team1Id)!;
      const team2Contextual = teamContextual.get(game.team2Id)!;

      if (!isInternational) {
        if (!ownContextualGamesByTeam.has(game.team1Id)) ownContextualGamesByTeam.set(game.team1Id, []);
        ownContextualGamesByTeam.get(game.team1Id)!.push({ opponent: team2Contextual, score: team1Score as 0 | 1, weight });

        if (!ownContextualGamesByTeam.has(game.team2Id)) ownContextualGamesByTeam.set(game.team2Id, []);
        ownContextualGamesByTeam
          .get(game.team2Id)!
          .push({ opponent: team1Contextual, score: (1 - team1Score) as 0 | 1, weight });
      } else {
        // A side whose league is unknown carries no league term; step 4 updates only input.leagueIds.
        const team1Meta = leagueMeta.get(game.team1LeagueId) ?? zeroDeviation;
        const team2Meta = leagueMeta.get(game.team2LeagueId) ?? zeroDeviation;
        const metaWeight = input.config.metaWeight ?? DEFAULT_META_WEIGHT;
        const team1LeagueWeight = effectiveMetaWeight(team1Meta, metaWeight, input.config.phiInitMax);
        const team2LeagueWeight = effectiveMetaWeight(team2Meta, metaWeight, input.config.phiInitMax);
        const team1MetaWeight = team1LeagueWeight * metaShrinkFor(game.team1Id);
        const team2MetaWeight = team2LeagueWeight * metaShrinkFor(game.team2Id);
        const team1Deviation = teamInternational.get(game.team1Id) ?? zeroDeviation;
        const team2Deviation = teamInternational.get(game.team2Id) ?? zeroDeviation;
        // sigma unused by g()/E(); 0 only satisfies RatingState's shape.
        const team1Combined = { mu: team1Contextual.mu + team1MetaWeight * team1Meta.mu + team1Deviation.mu, phi: Math.hypot(team1Contextual.phi, team1MetaWeight * team1Meta.phi, team1Deviation.phi), sigma: 0 };
        const team2Combined = { mu: team2Contextual.mu + team2MetaWeight * team2Meta.mu + team2Deviation.mu, phi: Math.hypot(team2Contextual.phi, team2MetaWeight * team2Meta.phi, team2Deviation.phi), sigma: 0 };

        // Own contextual rating moves against the opponent's full combined
        // strength (expectancy is combined-vs-combined); only the contextual half
        // absorbs the delta.
        const ownGames = [
          ...(contextualLearnsInternational ? [ownContextualGamesByTeam] : []),
          ...(teamInternationalPhiInit !== undefined ? [ownDeviationGamesByTeam] : []),
        ];
        for (const byTeam of ownGames) {
          if (!byTeam.has(game.team1Id)) byTeam.set(game.team1Id, []);
          byTeam.get(game.team1Id)!.push({
            opponent: team2Combined,
            score: team1Score as 0 | 1,
            weight,
            ownExpectancyMu: team1Combined.mu,
          });

          if (!byTeam.has(game.team2Id)) byTeam.set(game.team2Id, []);
          byTeam.get(game.team2Id)!.push({
            opponent: team1Combined,
            score: (1 - team1Score) as 0 | 1,
            weight,
            ownExpectancyMu: team2Combined.mu,
          });
        }

        if (!internationalGamesByLeague.has(game.team1LeagueId)) internationalGamesByLeague.set(game.team1LeagueId, []);
        internationalGamesByLeague.get(game.team1LeagueId)!.push({
          // updateLeagueMeta adds the unshrunk league weight back, so pass the remainder.
          ownContextualMu: team1Contextual.mu + team1Deviation.mu + (team1MetaWeight - team1LeagueWeight) * team1Meta.mu,
          opponentCombinedMu: team2Combined.mu,
          opponentCombinedPhi: team2Combined.phi,
          score: team1Score as 0 | 1,
          weight,
        });

        if (!internationalGamesByLeague.has(game.team2LeagueId)) internationalGamesByLeague.set(game.team2LeagueId, []);
        internationalGamesByLeague.get(game.team2LeagueId)!.push({
          ownContextualMu: team2Contextual.mu + team2Deviation.mu + (team2MetaWeight - team2LeagueWeight) * team2Meta.mu,
          opponentCombinedMu: team1Combined.mu,
          opponentCombinedPhi: team1Combined.phi,
          score: (1 - team1Score) as 0 | 1,
          weight,
        });
      }
    }

    // 3. Apply contextual updates for every team (empty list = inactivity growth only).
    for (const teamId of input.teamIds) {
      const games = ownContextualGamesByTeam.get(teamId) ?? [];
      const updated = updateRating(teamContextual.get(teamId)!, games, input.config.tau ?? DEFAULT_TAU, elapsedPeriods);
      teamContextual.set(teamId, updated);
      if (games.length > 0) {
        teamHistory.push({ teamId, asOfDate: period, mu: updated.mu, phi: updated.phi, sigma: updated.sigma, reason: 'game_update' });
        recordedContextual.set(teamId, updated);
      }
    }

    for (const game of periodGames) {
      if (game.team1LeagueId === game.team2LeagueId) continue;
      crossRegionGamesPlayed.set(game.team1Id, (crossRegionGamesPlayed.get(game.team1Id) ?? 0) + 1);
      crossRegionGamesPlayed.set(game.team2Id, (crossRegionGamesPlayed.get(game.team2Id) ?? 0) + 1);
    }

    for (const [teamId, deviation] of teamInternational) {
      const games = ownDeviationGamesByTeam.get(teamId) ?? [];
      const updated =
        teamInternationalHalfLifeDays === undefined
          ? updateRating(deviation, games, input.config.tau ?? DEFAULT_TAU, elapsedPeriods)
          : updateWithoutDrift(deviation, games);
      teamInternational.set(teamId, updated);
      if (games.length > 0) {
        teamInternationalHistory.push({ teamId, asOfDate: period, mu: updated.mu, phi: updated.phi, sigma: updated.sigma, reason: 'game_update' });
      }
    }

    // 4. Apply meta updates for every league (empty list = inactivity growth only).
    for (const leagueId of input.leagueIds) {
      const games = internationalGamesByLeague.get(leagueId) ?? [];
      const updated = updateLeagueMeta(
        leagueMeta.get(leagueId)!,
        games,
        input.config.tau ?? DEFAULT_TAU,
        input.config.metaWeight ?? DEFAULT_META_WEIGHT,
        input.config.phiInitMax,
        elapsedPeriods,
      );
      leagueMeta.set(leagueId, updated);
      if (games.length > 0) {
        leagueHistory.push({ leagueId, asOfDate: period, mu: updated.mu, phi: updated.phi, sigma: updated.sigma });
        recordedMeta.set(leagueId, updated);
        for (const [teamId, teamLeague] of teamLeagueOf) if (teamLeague === leagueId) touched.add(teamId);
      }
    }

    // 5. The cross-region strength a global board shows: contextual + faded league
    // term + the team's own international deviation, as an international game grades it.
    if (teamInternationalPhiInit !== undefined) {
      const lastPeriod = period === sortedPeriods[sortedPeriods.length - 1];
      for (const teamId of lastPeriod ? teamLeagueOf.keys() : touched) {
        // As last recorded, not live: the boards show RD as of a team's last game,
        // and live phi would penalise a team for idling while others play.
        const contextual = recordedContextual.get(teamId)!;
        const meta = recordedMeta.get(teamLeagueOf.get(teamId) ?? '') ?? zeroDeviation;
        const weight =
          effectiveMetaWeight(meta, input.config.metaWeight ?? DEFAULT_META_WEIGHT, input.config.phiInitMax) * metaShrinkFor(teamId);
        const deviation = teamInternational.get(teamId) ?? zeroDeviation;
        combinedHistory.push({
          teamId,
          asOfDate: period,
          mu: contextual.mu + weight * meta.mu + deviation.mu,
          phi: Math.hypot(contextual.phi, weight * meta.phi, deviation.phi),
          sigma: contextual.sigma,
          reason: 'game_update',
        });
      }
    }
  }

  return teamInternationalPhiInit === undefined
    ? { teamHistory, leagueHistory }
    : { teamHistory, leagueHistory, teamInternationalHistory, combinedHistory };
}
