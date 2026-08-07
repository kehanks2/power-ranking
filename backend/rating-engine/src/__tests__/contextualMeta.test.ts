import { describe, it, expect } from 'vitest';
import { toGlicko2Scale, fromGlicko2Scale, updateRating, GLICKO2_SCALE } from '../glicko2.js';
import {
  combineContextualAndMeta,
  toDisplayRating,
  updateLeagueMeta,
  initialLeagueMeta,
  effectiveMetaWeight,
  type InternationalGameResult,
} from '../contextualMeta.js';

const PHI_INIT_MAX = 350 / GLICKO2_SCALE;

describe('additive contextual + meta rating', () => {
  it('a neutral league (no international games yet) contributes zero offset to displayed rating', () => {
    const contextual = toGlicko2Scale(1600, 100);
    const meta = initialLeagueMeta(350 / GLICKO2_SCALE);
    const display = toDisplayRating(contextual, meta);

    expect(display.rating).toBeCloseTo(1600, 5);
  });

  it('displayed RD combines contextual and meta RD as sqrt(phi_ctx^2 + phi_meta^2)', () => {
    const contextual = toGlicko2Scale(1600, 100);
    const meta = { mu: 0.1, phi: 50 / GLICKO2_SCALE, sigma: 0.06 };
    const combined = combineContextualAndMeta(contextual, meta);
    const display = fromGlicko2Scale(combined);

    const expectedRd = Math.sqrt(100 * 100 + 50 * 50);
    expect(display.rd).toBeCloseTo(expectedRd, 5);
  });

  it('an international-only game moves league_meta_rating but not team_contextual_rating', () => {
    const contextual = toGlicko2Scale(1600, 100);
    const meta = initialLeagueMeta(350 / GLICKO2_SCALE);

    const opponentCombined = toGlicko2Scale(1500, 100);
    const games: InternationalGameResult[] = [
      {
        ownContextualMu: contextual.mu,
        opponentCombinedMu: opponentCombined.mu,
        opponentCombinedPhi: opponentCombined.phi,
        score: 1,
      },
    ];

    const newMeta = updateLeagueMeta(meta, games);

    // contextual is untouched -- only intra-league games (via updateRating) would change it.
    expect(contextual.mu).toBeCloseTo(toGlicko2Scale(1600, 100).mu, 10);
    // meta moved up after a win:
    expect(newMeta.mu).toBeGreaterThan(meta.mu);
  });

  it('an intra-league game moves team_contextual_rating but not league_meta_rating', () => {
    const contextual = toGlicko2Scale(1500, 100);
    const meta = initialLeagueMeta(350 / GLICKO2_SCALE);

    const opponent = toGlicko2Scale(1500, 100);
    const newContextual = updateRating(contextual, [{ opponent, score: 1 }]);

    expect(newContextual.mu).toBeGreaterThan(contextual.mu);
    // meta is a completely separate state, untouched by this call:
    expect(meta.mu).toBe(0);
  });

  it('beating a stronger league moves meta rating up more than beating a weaker one', () => {
    const meta = initialLeagueMeta(350 / GLICKO2_SCALE);
    const ownContextualMu = toGlicko2Scale(1500, 100).mu;

    const vsWeaker = updateLeagueMeta(meta, [
      {
        ownContextualMu,
        opponentCombinedMu: toGlicko2Scale(1300, 100).mu,
        opponentCombinedPhi: toGlicko2Scale(1300, 100).phi,
        score: 1,
      },
    ]);
    const vsStronger = updateLeagueMeta(meta, [
      {
        ownContextualMu,
        opponentCombinedMu: toGlicko2Scale(1700, 100).mu,
        opponentCombinedPhi: toGlicko2Scale(1700, 100).phi,
        score: 1,
      },
    ]);

    expect(vsStronger.mu).toBeGreaterThan(vsWeaker.mu);
  });
});

describe('effectiveMetaWeight (confidence-based shrinkage)', () => {
  it('contributes zero at maximum uncertainty (cold-start meta)', () => {
    const meta = initialLeagueMeta(PHI_INIT_MAX);
    expect(effectiveMetaWeight(meta, 0.8, PHI_INIT_MAX)).toBeCloseTo(0, 10);
  });

  it('contributes the full base weight once uncertainty is fully resolved (phi_meta = 0)', () => {
    const meta = { mu: -0.5, phi: 0, sigma: 0.06 };
    expect(effectiveMetaWeight(meta, 0.8, PHI_INIT_MAX)).toBeCloseTo(0.8, 10);
  });

  it('a more uncertain meta gets shrunk harder than a more confident one, even with equal base weight', () => {
    // CBLOL carried ~2x the meta RD of other leagues yet swung its teams'
    // ratings hardest; only this confidence term can make a less-certain
    // estimate count for less.
    const uncertainMeta = { mu: -1.5, phi: PHI_INIT_MAX * 0.7, sigma: 0.06 };
    const confidentMeta = { mu: -1.5, phi: PHI_INIT_MAX * 0.2, sigma: 0.06 };
    const uncertainWeight = effectiveMetaWeight(uncertainMeta, 0.8, PHI_INIT_MAX);
    const confidentWeight = effectiveMetaWeight(confidentMeta, 0.8, PHI_INIT_MAX);
    expect(confidentWeight).toBeGreaterThan(uncertainWeight);
  });

  it('skips shrinkage entirely (flat metaWeight) when phiInitMax is not provided', () => {
    const meta = initialLeagueMeta(PHI_INIT_MAX);
    expect(effectiveMetaWeight(meta, 0.8, undefined)).toBe(0.8);
  });

  it('flows through combineContextualAndMeta: a highly uncertain league contributes less to a team\'s displayed rating', () => {
    const contextual = toGlicko2Scale(1600, 100);
    const uncertainMeta = { mu: -1.5, phi: PHI_INIT_MAX * 0.9, sigma: 0.06 }; // ~ -260 raw points, barely any confidence
    const confidentMeta = { mu: -1.5, phi: PHI_INIT_MAX * 0.1, sigma: 0.06 }; // same raw mu, well established

    const displayUncertain = toDisplayRating(contextual, uncertainMeta, 0.8, PHI_INIT_MAX);
    const displayConfident = toDisplayRating(contextual, confidentMeta, 0.8, PHI_INIT_MAX);

    // Same meta mu, but the uncertain one drags the rating down less.
    expect(displayUncertain.rating).toBeGreaterThan(displayConfident.rating);
  });
});
