import { describe, it, expect } from 'vitest';
import { computeMovWeight } from '../movWeight.js';
import { updateRating, toGlicko2Scale, fromGlicko2Scale, type GameResult } from '../glicko2.js';

const MARGIN_SCALE = 15;
const CAP = 1.5;

describe('computeMovWeight', () => {
  it('returns close to 1.0 for a nail-biter (near-zero gold diff)', () => {
    const weight = computeMovWeight(
      { team1Gold: 45000, team2Gold: 44980, gamelengthSeconds: 35 * 60 },
      MARGIN_SCALE,
      CAP,
    );
    expect(weight).toBeGreaterThanOrEqual(1);
    expect(weight).toBeLessThan(1.1);
  });

  it('returns a higher weight for a decisive stomp', () => {
    const nailBiter = computeMovWeight(
      { team1Gold: 45000, team2Gold: 44980, gamelengthSeconds: 35 * 60 },
      MARGIN_SCALE,
      CAP,
    );
    const stomp = computeMovWeight(
      { team1Gold: 60000, team2Gold: 30000, gamelengthSeconds: 25 * 60 },
      MARGIN_SCALE,
      CAP,
    );
    expect(stomp).toBeGreaterThan(nailBiter);
  });

  it('caps the weight so one extreme stomp cannot dominate', () => {
    const extreme = computeMovWeight(
      { team1Gold: 200000, team2Gold: 1000, gamelengthSeconds: 10 * 60 },
      MARGIN_SCALE,
      CAP,
    );
    expect(extreme).toBe(CAP);
  });

  it('a synthetic stomp moves rating more than a nail-biter for the same win/loss outcome', () => {
    const base = toGlicko2Scale(1500, 100);
    const opponent = toGlicko2Scale(1500, 100);

    const nailBiterWeight = computeMovWeight(
      { team1Gold: 45000, team2Gold: 44900, gamelengthSeconds: 35 * 60 },
      MARGIN_SCALE,
      CAP,
    );
    const stompWeight = computeMovWeight(
      { team1Gold: 60000, team2Gold: 30000, gamelengthSeconds: 25 * 60 },
      MARGIN_SCALE,
      CAP,
    );

    const gamesNailBiter: GameResult[] = [{ opponent, score: 1, weight: nailBiterWeight }];
    const gamesStomp: GameResult[] = [{ opponent, score: 1, weight: stompWeight }];

    const afterNailBiter = fromGlicko2Scale(updateRating(base, gamesNailBiter));
    const afterStomp = fromGlicko2Scale(updateRating(base, gamesStomp));

    expect(afterStomp.rating).toBeGreaterThan(afterNailBiter.rating);
  });

  it('applies the same weight to both teams\' perspectives of the same game (symmetry)', () => {
    const teamA = toGlicko2Scale(1500, 100);
    const teamB = toGlicko2Scale(1500, 100);
    const weight = computeMovWeight(
      { team1Gold: 60000, team2Gold: 30000, gamelengthSeconds: 25 * 60 },
      MARGIN_SCALE,
      CAP,
    );

    // Team A won, Team B lost -- same game, same weight applied from both sides.
    const aAfter = fromGlicko2Scale(
      updateRating(teamA, [{ opponent: teamB, score: 1, weight }]),
    );
    const bAfter = fromGlicko2Scale(
      updateRating(teamB, [{ opponent: teamA, score: 0, weight }]),
    );

    // By symmetry of a single 50/50 matchup, the winner's gain and loser's drop
    // should be equal in magnitude.
    expect(aAfter.rating - 1500).toBeCloseTo(1500 - bAfter.rating, 5);
  });
});
