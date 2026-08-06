/**
 * Pure orchestrator that replays a full game history through the rating
 * engine, period by period. Deliberately has no DB/network dependency (see
 * plan: rating-engine stays "pure, heavily unit-tested") -- a thin caller
 * elsewhere loads games/teams/leagues from Postgres, builds this input, and
 * persists the returned history rows.
 *
 * "Full replay from period 1 is always the supported recovery path" (plan) --
 * this function IS that replay: it is a pure function of
 * (games + decay events + config), safe to re-run from scratch at any time.
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
  /**
   * Which series (Bo1/Bo3/Bo5) this game belongs to. Optional for backwards
   * compatibility with synthetic single-game test fixtures; when absent the
   * game is treated as its own series (no correlation correction).
   */
  seriesId?: string;
}

/** A roster-change decay event, already resolved by the caller (turnover + roster-implied prior). */
export interface RosterDecayEvent {
  kind: 'roster_change';
  teamId: string;
  effectiveDate: string; // ISO date
  turnover: number;
  rosterImpliedMu: number;
  /**
   * Mean confidence (0-1) of the incoming players' ratings -- the same signal
   * that shaped rosterImpliedMu. Optional for older/synthetic fixtures; absent
   * means "no prior knowledge", i.e. the full RD reset.
   */
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
  /**
   * Intra-series correlation (rho), 0..1 -- see seriesEvidenceWeight.
   * Defaults to 0, which reproduces the original (uncorrected) behavior.
   */
  seriesCorrelation?: number;
  /**
   * Glicko-2's tau: constrains how fast volatility (and therefore how hard a
   * rating chases short-term swings) can change. Glickman suggests 0.3-1.2,
   * smaller for domains with less genuine week-to-week skill change. This was
   * previously pinned at DEFAULT_TAU (0.5) because runReplay never forwarded
   * it to updateRating -- exposed here so it can actually be tuned.
   */
  tau?: number;
  /**
   * Rating-period length in days (default 7). Glicko-2 applies one update per
   * period, so every game inside a period is evaluated against the ratings as
   * they stood at the period's START -- with weekly periods a team's Saturday
   * result is graded using Monday's rating, ignoring what it did midweek.
   * Shorter periods mean fresher ratings but fewer games each, so this is an
   * empirical trade-off rather than an obvious win.
   */
  ratingPeriodDays?: number;
  /** See DEFAULT_PRIOR_CONFIDENCE_RELIEF -- how much a confident roster prior damps the RD widening. */
  priorConfidenceRelief?: number;
  /**
   * Extra evidence weight on international games in the CONTEXTUAL update
   * (1 = no change).
   *
   * Regional games can only move a team within its own league; international
   * games are the only ones carrying cross-region information, yet they are a
   * minority of any team's schedule and are damped further by
   * seriesCorrelation. Confirmed against real data: Bilibili Gaming went 3-2
   * against T1 and 5-4 against Hanwha Life in 2026 international play, won
   * First Stand outright, and still ranked 103 points below T1, because ~200
   * LPL regional games outvoted ~100 international ones.
   */
  internationalWeightMultiplier?: number;
  /**
   * Half-life in days for down-weighting older games as evidence. Omitted or
   * Infinity means no recency weighting, which is the production behaviour.
   *
   * Glicko already lets ratings move over time, but every game counts as
   * equally strong evidence no matter how old. That is defensible over a
   * dense domestic schedule and much less so over a sparse one: a rating built
   * from international games alone spans years, across which a team's roster
   * and identity turn over completely.
   */
  recencyHalfLifeDays?: number;
  /** Date recency is measured from. Defaults to the latest game in the input. */
  recencyReferenceDate?: string;
}

/**
 * Glicko-2 assumes each result is an INDEPENDENT observation. Games inside a
 * Bo3/Bo5 badly violate that: same two teams, same day, same patch, same
 * draft context, carried-over reads. Counting a 3-0 as three independent wins
 * overstates the evidence, which shrinks phi too fast and makes the model
 * overconfident -- measured directly: predictions in the 90-95% band only won
 * ~79% of the time, and our data averages ~2.8 games per series.
 *
 * Standard clustered-sampling correction (the "design effect"): for a cluster
 * of n correlated observations with intra-cluster correlation rho, the
 * effective sample size is n / (1 + (n-1)*rho), so each observation should
 * carry weight 1 / (1 + (n-1)*rho).
 *
 * rho = 0   -> weight 1     (fully independent; original behavior)
 * rho = 1   -> weight 1/n   (a whole series counts as one observation)
 * Parameterized rather than hardcoded to 1/n or 1/sqrt(n) because rho is a
 * real, tunable quantity with a statistical meaning -- backtested rather than
 * assumed (see manualSeriesCorrelationSweep.ts).
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
  // Series sizes are counted across the WHOLE input, not per period, so the
  // correction reflects the real Bo3/Bo5 length even in the (currently
  // impossible, but not guaranteed) case of a series straddling two periods.
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
    teamContextual.set(teamId, { mu: 0, phi: input.config.phiInitMax, sigma: input.config.sigmaDefault });
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

  // Drift is a random walk: its variance grows with elapsed TIME, not with the
  // number of buckets that time is sliced into. `sortedPeriods` only contains
  // periods that actually hold a game or a decay event, so measuring elapsed
  // time from the PREVIOUS occupied period is what makes the two equivalent.
  //
  // Using a constant `periodDays / SIGMA_REFERENCE_DAYS` here was wrong: empty
  // periods are never iterated, so a gap with no games anywhere contributed no
  // drift at all. Confirmed against real data -- 342 of 934 calendar days in
  // the dataset have no games, including the two ~10-week post-Worlds
  // offseasons. Teams therefore came into each new season carrying their old
  // certainty, which is precisely backwards: that gap is when rosters churn
  // most. applySeasonalDecay's doc comment even documents relying on this
  // ("RD growth across the offseason gap already happens for free via
  // updateRating([]) during periods with no games") -- it never did.
  let previousPeriod: string | null = null;
  for (const period of sortedPeriods) {
    // Zero for the first period: no time has elapsed before the very first
    // observation, and teams already start at phiInitMax (maximum
    // uncertainty), so there is nothing for drift to add. Seeding this with
    // `periodDays` instead would make the total drift depend on the period
    // length again -- the exact coupling this is meant to remove.
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

    // 2. Split this period's games into intra-league and international, but note
    // BOTH kinds feed a team's own contextual rating (ownContextualGamesByTeam) --
    // international games additionally feed league meta. A team that personally
    // wins an international tournament must be rewarded on its own rating, not
    // just via a league-wide meta bump shared equally with teams that didn't even
    // play (confirmed against real data: HLE winning MSI 2026 outright barely
    // moved their own rating under the old design, since only LCK's shared meta
    // moved -- every LCK team got the same credit HLE earned personally).
    const periodGames = gamesByPeriod.get(period) ?? [];
    const ownContextualGamesByTeam = new Map<string, GameResult[]>();
    const internationalGamesByLeague = new Map<string, InternationalGameResult[]>();

    for (const game of periodGames) {
      // Both factors scale the same per-game evidence term and are applied
      // identically to both sides (see movWeight.ts's symmetry note).
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
        // sigma is unused by g()/E() (only mu/phi feed expectancy) -- carried
        // along only to satisfy RatingState's shape for reuse as a GameResult opponent.
        const team1Combined = { mu: team1Contextual.mu + team1MetaWeight * team1Meta.mu, phi: Math.hypot(team1Contextual.phi, team1MetaWeight * team1Meta.phi), sigma: 0 };
        const team2Combined = { mu: team2Contextual.mu + team2MetaWeight * team2Meta.mu, phi: Math.hypot(team2Contextual.phi, team2MetaWeight * team2Meta.phi), sigma: 0 };

        // Own contextual rating moves too, using the opponent's full combined
        // strength as the comparison point (their bare contextual number alone
        // isn't calibrated cross-region).
        // Expectancy is combined-vs-combined so both sides grade the same game
        // identically; only the contextual half absorbs the resulting delta.
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
