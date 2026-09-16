import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { placementSortValue, isTeamStanding, placementSourceNames, ingestPlacements } from '../ingestPlacements.js';
import { fetchPlacements, type LiquipediaPlacement } from '../liquipediaApi.js';

vi.mock('../liquipediaApi.js', () => ({ fetchPlacements: vi.fn() }));

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

describe('ingestPlacements', () => {
  const pool = (): Pool =>
    ({
      query: async (sql: string) => ({ rows: sql.includes('tournaments') ? [{ id: 1, name: 'LCK 2026 Summer' }] : [] }),
      connect: async () => {
        throw new Error('connected to write');
      },
    }) as unknown as Pool;

  it('writes nothing when Liquipedia returns no team standings', async () => {
    // The refresh wipes the table before reloading it, and now runs unattended
    // every day: an empty 200 must not blank every Results cell on the site.
    vi.mocked(fetchPlacements).mockResolvedValue([row({ opponenttype: 'solo', placement: '' })]);

    await expect(ingestPlacements(pool())).resolves.toMatchObject({ placementsInserted: 0 });
  });

  it('writes when there is a standing to write', async () => {
    vi.mocked(fetchPlacements).mockResolvedValue([row({ tournament: 'LCK 2026 Season' })]);

    await expect(ingestPlacements(pool())).rejects.toThrow('connected to write');
  });
});
