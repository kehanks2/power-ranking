import { describe, it, expect } from 'vitest';
import { placementSortValue, isTeamStanding, placementSourceNames } from '../ingestPlacements.js';
import type { LiquipediaPlacement } from '../liquipediaApi.js';

const row = (over: Partial<LiquipediaPlacement>): LiquipediaPlacement => ({
  tournament: '2026 Mid-Season Invitational',
  opponentname: 'T1',
  opponenttype: 'team',
  placement: '1',
  prizemoney: 500000,
  ...over,
});

describe('placementSourceNames', () => {
  it('draws LCK split standings from their real Liquipedia brackets', () => {
    expect(placementSourceNames('LCK 2026 Spring')).toEqual(['LCK 2026 Road to MSI']);
    expect(placementSourceNames('LCK 2025 Summer')).toEqual(['LCK 2025 Season']);
  });

  it('leaves every other tournament to its own name', () => {
    expect(placementSourceNames('LCK Cup 2026')).toEqual(['LCK Cup 2026']);
    expect(placementSourceNames('LPL 2026 Split 1')).toEqual(['LPL 2026 Split 1']);
  });
});

describe('placementSortValue', () => {
  it('reads a plain finish', () => {
    expect(placementSortValue('1')).toBe(1);
    expect(placementSortValue('11')).toBe(11);
  });

  it('sorts a shared finish by its best position', () => {
    // Liquipedia writes ties as ranges wherever a bracket plays no
    // third-place or consolation match. "5-6" is 5th equal, not 5th.
    expect(placementSortValue('5-6')).toBe(5);
    expect(placementSortValue('9-11')).toBe(9);
  });

  it('returns null for anything that is not a finish', () => {
    expect(placementSortValue('')).toBeNull();
    expect(placementSortValue('Q')).toBeNull();
    expect(placementSortValue('DQ')).toBeNull();
  });
});

describe('isTeamStanding', () => {
  it('accepts a team row with a real finish', () => {
    expect(isTeamStanding(row({}))).toBe(true);
    expect(isTeamStanding(row({ placement: '7-8' }))).toBe(true);
  });

  it('rejects individual awards, which share the endpoint but are not standings', () => {
    // The 2026 MSI response really does include a solo row for Zeus.
    expect(isTeamStanding(row({ opponenttype: 'solo', opponentname: 'Zeus', placement: '' }))).toBe(false);
  });

  it('rejects a team row with no finish recorded', () => {
    expect(isTeamStanding(row({ placement: '' }))).toBe(false);
  });
});
