/**
 * Replays a full game history through the rating engine, period by period. No
 * DB or network: a pure function of (games + decay events + config), so a full
 * replay from period 1 is always a safe recovery path. A thin caller loads from
 * Postgres and persists the returned history rows.
 */

import { updateRating, DEFAULT_TAU, SIGMA_REFERENCE_DAYS, type RatingState, type GameResult } from './glicko2.js';
import { updateLeagueMeta, effectiveMetaWeight, DEFAULT_META_WEIGHT, type InternationalGameResult } from './contextualMeta.js';
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
  /** Half-life for down-weighting older games. Omitted/Infinity = none (production). */
  recencyHalfLifeDays?: number;
  /** Date recency is measured from. Defaults to the latest game in the input. */
  recencyReferenceDate?: string;
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
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_RATING_PERIOD_DAYS = 7;

function periodBucket(dateIso: string, periodDays: number): string {
  const periodMs = periodDays * MS_PER_DAY;
  const epochPeriod = Math.floor(new Date(dateIso).getTime() / periodMs);
  return new Date(epochPeriod * periodMs).toISOString().slice(0, 10);
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

  const teamHistory: TeamRatingSnapshot[] = [];
  const leagueHistory: LeagueRatingSnapshot[] = [];
  const earliestDate = input.games.length > 0 ? [...input.games].sort((a, b) => (a.datetimeUtc < b.datetimeUtc ? -1 : 1))[0].datetimeUtc.slice(0, 10) : new Date().toISOString().slice(0, 10);

  for (const teamId of input.teamIds) {
    const state = teamContextual.get(teamId)!;
    teamHistory.push({ teamId, asOfDate: earliestDate, mu: state.mu, phi: state.phi, sigma: state.sigma, reason: 'initial' });
  }
  for (const leagueId of input.leagueIds) {
    const state = leagueMeta.get(leagueId)!;
    leagueHistory.push({ leagueId, asOfDate: earliestDate, mu: state.mu, phi: state.phi, sigma: state.sigma });
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

    // 1. Apply decay events dated in this period, before this period's games.
    for (const teamId of input.teamIds) {
      const events = decayByTeamAndPeriod.get(`${teamId}::${period}`);
      if (!events || events.length === 0) continue;

      const rosterEvent = events.find((e): e is RosterDecayEvent => e.kind === 'roster_change');
      const seasonalEvent = events.find((e): e is SeasonalDecayEvent => e.kind === 'seasonal');
      const current = teamContextual.get(teamId)!;

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
    const internationalGamesByLeague = new Map<string, InternationalGameResult[]>();

    for (const game of periodGames) {
      const isInternational = game.team1LeagueId !== game.team2LeagueId;
      const weight =
        movWeightForGame(game, input.config) *
        seriesWeightFor(game) *
        recencyWeightFor(game) *
        (isInternational ? (input.config.internationalWeightMultiplier ?? 1) : 1);
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
        const team1Meta = leagueMeta.get(game.team1LeagueId)!;
        const team2Meta = leagueMeta.get(game.team2LeagueId)!;
        const metaWeight = input.config.metaWeight ?? DEFAULT_META_WEIGHT;
        const team1MetaWeight = effectiveMetaWeight(team1Meta, metaWeight, input.config.phiInitMax);
        const team2MetaWeight = effectiveMetaWeight(team2Meta, metaWeight, input.config.phiInitMax);
        // sigma unused by g()/E(); 0 only satisfies RatingState's shape.
        const team1Combined = { mu: team1Contextual.mu + team1MetaWeight * team1Meta.mu, phi: Math.hypot(team1Contextual.phi, team1MetaWeight * team1Meta.phi), sigma: 0 };
        const team2Combined = { mu: team2Contextual.mu + team2MetaWeight * team2Meta.mu, phi: Math.hypot(team2Contextual.phi, team2MetaWeight * team2Meta.phi), sigma: 0 };

        // Own contextual rating moves against the opponent's full combined
        // strength (expectancy is combined-vs-combined); only the contextual half
        // absorbs the delta.
        if (!ownContextualGamesByTeam.has(game.team1Id)) ownContextualGamesByTeam.set(game.team1Id, []);
        ownContextualGamesByTeam.get(game.team1Id)!.push({
          opponent: team2Combined,
          score: team1Score as 0 | 1,
          weight,
          ownExpectancyMu: team1Combined.mu,
        });

        if (!ownContextualGamesByTeam.has(game.team2Id)) ownContextualGamesByTeam.set(game.team2Id, []);
        ownContextualGamesByTeam.get(game.team2Id)!.push({
          opponent: team1Combined,
          score: (1 - team1Score) as 0 | 1,
          weight,
          ownExpectancyMu: team2Combined.mu,
        });

        if (!internationalGamesByLeague.has(game.team1LeagueId)) internationalGamesByLeague.set(game.team1LeagueId, []);
        internationalGamesByLeague.get(game.team1LeagueId)!.push({
          ownContextualMu: team1Contextual.mu,
          opponentCombinedMu: team2Combined.mu,
          opponentCombinedPhi: team2Combined.phi,
          score: team1Score as 0 | 1,
          weight,
        });

        if (!internationalGamesByLeague.has(game.team2LeagueId)) internationalGamesByLeague.set(game.team2LeagueId, []);
        internationalGamesByLeague.get(game.team2LeagueId)!.push({
          ownContextualMu: team2Contextual.mu,
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
      }
    }
  }

  return { teamHistory, leagueHistory };
}
