import { describe, it, expect } from 'vitest';
import { resolveLeagueAlias, type LeagueAlias } from '../leagueAlias.js';

const LCS_ID = 4;
const CBLOL_ID = 5;

const aliases: LeagueAlias[] = [
  { rawLeagueName: 'LCS', canonicalLeagueId: LCS_ID, validFrom: '2016-01-01', validTo: null },
  { rawLeagueName: 'CBLOL', canonicalLeagueId: CBLOL_ID, validFrom: '2016-01-01', validTo: null },
  { rawLeagueName: 'LTAN', canonicalLeagueId: LCS_ID, validFrom: '2025-01-01', validTo: '2025-12-31' },
  { rawLeagueName: 'LTAS', canonicalLeagueId: CBLOL_ID, validFrom: '2025-01-01', validTo: '2025-12-31' },
];

describe('resolveLeagueAlias', () => {
  it('resolves LTAN to LCS for a 2025 tournament date', () => {
    expect(resolveLeagueAlias('LTAN', '2025-06-01', aliases)).toBe(LCS_ID);
  });

  it('resolves LTAS to CBLOL for a 2025 tournament date', () => {
    expect(resolveLeagueAlias('LTAS', '2025-06-01', aliases)).toBe(CBLOL_ID);
  });

  it('resolves plain LCS both before and after the LTA window', () => {
    expect(resolveLeagueAlias('LCS', '2020-06-01', aliases)).toBe(LCS_ID);
    expect(resolveLeagueAlias('LCS', '2026-06-01', aliases)).toBe(LCS_ID);
  });

  it('does not resolve LTAN outside its valid date range', () => {
    expect(resolveLeagueAlias('LTAN', '2026-06-01', aliases)).toBeNull();
  });

  it('returns null for a completely unknown raw name rather than guessing', () => {
    expect(resolveLeagueAlias('LLA', '2025-06-01', aliases)).toBeNull();
  });
});

describe('resolveLeagueAlias with real Date objects (regression)', () => {
  // `pg` returns DATE columns as JS Date objects, not strings, no matter what
  // a TS type annotation on the query claims. A real production bug lived
  // here: comparing a string asOfDate against an un-normalized Date via `>=`
  // silently coerces to NaN and is always false, so every single lookup
  // returned null in production despite this file's string-literal-only
  // tests above passing the whole time -- the bug only showed up on the real
  // DB round trip, never in a unit test using clean string literals.
  const dateAliases: LeagueAlias[] = [
    { rawLeagueName: 'LCS', canonicalLeagueId: LCS_ID, validFrom: new Date('2016-01-01T06:00:00.000Z'), validTo: null },
    {
      rawLeagueName: 'LTAN',
      canonicalLeagueId: LCS_ID,
      validFrom: new Date('2025-01-01T06:00:00.000Z'),
      validTo: new Date('2025-12-31T06:00:00.000Z'),
    },
  ];

  it('resolves correctly when validFrom/validTo are Date objects, not strings', () => {
    expect(resolveLeagueAlias('LCS', '2026-06-01', dateAliases)).toBe(LCS_ID);
    expect(resolveLeagueAlias('LTAN', '2025-06-01', dateAliases)).toBe(LCS_ID);
    expect(resolveLeagueAlias('LTAN', '2026-06-01', dateAliases)).toBeNull();
  });

  it('resolves correctly when asOfDate is ALSO a Date object (e.g. from datetime_utc)', () => {
    expect(resolveLeagueAlias('LCS', new Date('2026-06-01T12:00:00.000Z'), dateAliases)).toBe(LCS_ID);
  });
});
