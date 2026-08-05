/**
 * Core Glicko-2 rating engine (Glickman, "Example of the Glicko-2 system").
 * Generalized with a per-game `weight` (default 1.0) so margin-of-victory
 * weighting (see movWeight.ts) can scale a game's influence on `v`/`delta`
 * without touching the win/loss outcome itself -- see the plan's rationale
 * for why `s` must stay a pure win-probability signal.
 */

export const GLICKO2_SCALE = 173.7178;
export const DEFAULT_RATING = 1500;
export const DEFAULT_RD = 350;
export const DEFAULT_VOLATILITY = 0.06;
export const DEFAULT_TAU = 0.5;

export interface RatingState {
  mu: number;
  phi: number;
  sigma: number;
}

export interface DisplayRating {
  rating: number;
  rd: number;
}

export interface GameResult {
  /**
   * Rating to use for THIS side when computing the expected score, if it
   * differs from the rating being updated. Needed for international games,
   * where the comparison must be like-for-like (each side's contextual + its
   * league meta) even though only the contextual part is being updated.
   *
   * Without it the two sides of one game disagree about that game: grading
   * each team's bare contextual against the opponent's contextual + meta made
   * both teams underdogs simultaneously. On a real BLG vs T1 matchup the two
   * updates implied P(BLG wins) = 23.2% and 57.2% respectively -- win
   * probabilities summing to 66%, not 100%. updateLeagueMeta already avoided
   * this by building ownCombinedMu before calling E(); this is the same fix
   * for the contextual half.
   *
   * Omitted for intra-league games, where both sides share a league meta that
   * cancels, so the bare contextual comparison is already like-for-like.
   */
  ownExpectancyMu?: number;
  /** Opponent's rating state at the start of the period. */
  opponent: RatingState;
  /** 1 = win, 0 = loss. Glicko-2 also supports 0.5 for a draw, not used in LoL. */
  score: 0 | 0.5 | 1;
  /** Margin-of-victory weight for this specific game; 1.0 = no adjustment. */
  weight?: number;
}

export function toGlicko2Scale(rating: number, rd: number): RatingState {
  return {
    mu: (rating - DEFAULT_RATING) / GLICKO2_SCALE,
    phi: rd / GLICKO2_SCALE,
    sigma: DEFAULT_VOLATILITY,
  };
}

export function fromGlicko2Scale(state: Pick<RatingState, 'mu' | 'phi'>): DisplayRating {
  return {
    rating: state.mu * GLICKO2_SCALE + DEFAULT_RATING,
    rd: state.phi * GLICKO2_SCALE,
  };
}

// Default conservative-ranking discount (in RD units) -- see conservativeRank.
export const DEFAULT_CONSERVATIVE_K = 1;

/**
 * Sort/rank key, NOT a replacement for `rating`. Confirmed against real data
 * this matters: a team fresh off a roster change (wide RD) can beat one or
 * two elite, low-RD opponents and its raw mu jumps to the top of the board --
 * mathematically correct per-game (Glicko-2 SHOULD move a lot on a surprising
 * result under high uncertainty), but misleading as a ranked list, since a
 * team with RD=150 could plausibly be anywhere from top-10 to top-40 and a
 * naive mu-sort presents it as a confident #2. Same convention used by
 * TrueSkill/Xbox Live matchmaking (mu - k*sigma) for exactly this reason:
 * rank conservatively on uncertain estimates, let the point estimate (mu)
 * still be shown as-is for transparency. Does NOT change `rating` itself and
 * must NOT be used for single-game win-probability prediction (E() already
 * uses the unbiased mu/phi directly -- discounting there would make
 * predictions worse, not more honest).
 */
export function conservativeRank(display: DisplayRating, k: number = DEFAULT_CONSERVATIVE_K): number {
  return display.rating - k * display.rd;
}

// Exported so contextualMeta.ts can build the league-meta update, which needs
// the same g/E/volatility-solving primitives but applies the resulting delta
// to a different state (league meta) than the one expectancy is computed from
// (team contextual + league meta combined) -- see updateLeagueMeta.
export function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

export function E(mu: number, muOpponent: number, phiOpponent: number): number {
  return 1 / (1 + Math.exp(-g(phiOpponent) * (mu - muOpponent)));
}

/** Illinois algorithm (regula falsi variant) for solving for new volatility. Glickman, step 5. */
export function solveNewVolatility(phi: number, sigma: number, v: number, delta: number, tau: number): number {
  const a = Math.log(sigma * sigma);
  const f = (x: number): number => {
    const ex = Math.exp(x);
    const num = ex * (delta * delta - phi * phi - v - ex);
    const den = 2 * (phi * phi + v + ex) ** 2;
    return num / den - (x - a) / (tau * tau);
  };

  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0) {
      k += 1;
    }
    B = a - k * tau;
  }

  let fA = f(A);
  let fB = f(B);
  const epsilon = 1e-6;
  let iterations = 0;
  while (Math.abs(B - A) > epsilon && iterations < 100) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB < 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    B = C;
    fB = fC;
    iterations += 1;
  }

  return Math.exp(A / 2);
}

/**
 * Reference length, in days, that `sigma` is expressed against. Glicko-2
 * defines volatility per rating period without fixing the period's duration,
 * so the reference has to be pinned somewhere: 7 days, matching the weekly
 * buckets this engine was originally tuned with, so DEFAULT_VOLATILITY keeps
 * its calibrated meaning.
 */
export const SIGMA_REFERENCE_DAYS = 7;

/**
 * Applies one rating-period update for a single player/team.
 * `games` should contain every game that player/team played in the period.
 * Passing an empty array is the "no games this period" case: phi grows to
 * reflect inactivity, mu and sigma are unchanged -- this is what makes RD
 * widen automatically during any gap with no games, no extra rule needed.
 *
 * `elapsedPeriods` is how much TIME this period represents, in units of
 * SIGMA_REFERENCE_DAYS. Rating drift is a random walk, so its variance grows
 * with elapsed time (sigma^2 * t) -- NOT with how many buckets we happen to
 * slice that time into. Applying a full sigma^2 per bucket (the old
 * behavior, equivalent to elapsedPeriods = 1 always) meant that shortening
 * the rating period silently multiplied the drift: one idle week cost
 * sigma^2 under weekly buckets but 7*sigma^2 under daily ones. Confirmed in
 * practice -- switching to daily periods pushed median displayed RD from ~73
 * to ~125 purely from bucket-counting, which is why period length could not
 * be tuned independently before this.
 */
export function updateRating(
  current: RatingState,
  games: GameResult[],
  tau = DEFAULT_TAU,
  elapsedPeriods = 1,
): RatingState {
  if (games.length === 0) {
    const phiStar = Math.sqrt(current.phi * current.phi + current.sigma * current.sigma * elapsedPeriods);
    return { mu: current.mu, phi: phiStar, sigma: current.sigma };
  }

  let vInverse = 0;
  let deltaSum = 0;
  for (const game of games) {
    const weight = game.weight ?? 1;
    const gPhiJ = g(game.opponent.phi);
    const eValue = E(game.ownExpectancyMu ?? current.mu, game.opponent.mu, game.opponent.phi);
    vInverse += weight * gPhiJ * gPhiJ * eValue * (1 - eValue);
    deltaSum += weight * gPhiJ * (game.score - eValue);
  }
  const v = 1 / vInverse;
  const delta = v * deltaSum;

  const newSigma = solveNewVolatility(current.phi, current.sigma, v, delta, tau);

  const phiStar = Math.sqrt(current.phi * current.phi + newSigma * newSigma * elapsedPeriods);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = current.mu + newPhi * newPhi * deltaSum;

  return { mu: newMu, phi: newPhi, sigma: newSigma };
}
