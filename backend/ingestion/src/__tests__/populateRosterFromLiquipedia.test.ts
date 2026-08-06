import { describe, it, expect } from 'vitest';
import {
  buildSecondaryTeams,
  humanizePagename,
  isStarterFromRole,
  squadMemberFromPlayerRow,
  squadMemberFromSquadRow,
} from '../populateRosterFromLiquipedia.js';
import type { LiquipediaPlayer, LiquipediaSquadPlayer } from '../liquipediaApi.js';

describe('isStarterFromRole', () => {
  it('treats an empty role as a current starter', () => {
    expect(isStarterFromRole('')).toBe(true);
  });

  it('treats "Substitute" (any casing/whitespace) as NOT a starter', () => {
    expect(isStarterFromRole('Substitute')).toBe(false);
    expect(isStarterFromRole('substitute')).toBe(false);
    expect(isStarterFromRole('  SUBSTITUTE  ')).toBe(false);
  });

  it('treats any other label as NOT a starter, including ones not seen yet', () => {
    // The test is "is there a label", not a list of known ones, so an
    // unfamiliar tag fails safe rather than promoting someone to starter.
    expect(isStarterFromRole('Loan')).toBe(false);
    expect(isStarterFromRole('Inactive')).toBe(false);
    expect(isStarterFromRole('Captain')).toBe(false);
  });

  it('does not throw on null/undefined -- defensively treats as a starter', () => {
    expect(isStarterFromRole(null)).toBe(true);
    expect(isStarterFromRole(undefined)).toBe(true);
  });
});

describe('buildSecondaryTeams', () => {
  const row = (id: string, pagename: string, type = 'player') =>
    ({ id, pagename, type }) as LiquipediaSquadPlayer;
  const tracked = new Set(['Team_Vitality', 'G2_Esports']);

  it('reports the academy squad a tier-1 player is concurrently on', () => {
    // Vitality's second five are all listed active on both squads at once,
    // which is why they carry zero tier-1 games.
    const map = buildSecondaryTeams([row('rym', 'Team_Vitality'), row('rym', 'Rising_Bees')], tracked);
    expect(map.get('rym')).toBe('Rising_Bees');
  });

  it('says nothing about a player on one squad', () => {
    expect(buildSecondaryTeams([row('Carzzy', 'Team_Vitality')], tracked).has('Carzzy')).toBe(false);
  });

  it('ignores two TRACKED teams -- that is a transfer, not an academy deal', () => {
    const map = buildSecondaryTeams([row('X', 'Team_Vitality'), row('X', 'G2_Esports')], tracked);
    expect(map.has('X')).toBe(false);
  });

  it('ignores a player on no tracked team at all', () => {
    // Nothing on our boards for it to explain.
    const map = buildSecondaryTeams([row('Y', 'Rising_Bees'), row('Y', 'Karmine_Corp_Blue_Stars')], tracked);
    expect(map.has('Y')).toBe(false);
  });

  it('ignores staff rows', () => {
    const map = buildSecondaryTeams([row('Coach', 'Team_Vitality', 'staff'), row('Coach', 'Rising_Bees', 'staff')], tracked);
    expect(map.has('Coach')).toBe(false);
  });

  it('picks deterministically when several untracked squads are listed', () => {
    const rows = [row('Z', 'Team_Vitality'), row('Z', 'Zerance_Bloom'), row('Z', 'Rising_Bees')];
    expect(buildSecondaryTeams(rows, tracked).get('Z')).toBe('Rising_Bees');
  });
});

describe('humanizePagename', () => {
  it('reads a page name as a team name', () => {
    expect(humanizePagename('Rising_Bees')).toBe('Rising Bees');
    expect(humanizePagename('Karmine_Corp_Blue_Stars')).toBe('Karmine Corp Blue Stars');
  });
});

describe('squadMemberFromSquadRow loan direction', () => {
  const row = (extradata: LiquipediaSquadPlayer['extradata']): LiquipediaSquadPlayer =>
    ({ id: 'Karaage', position: 'Mid', role: 'Loan', type: 'player', status: 'active', joindate: '2026-01-20', extradata }) as LiquipediaSquadPlayer;

  it('drops a player loaned OUT -- they play for someone else', () => {
    expect(squadMemberFromSquadRow(row({ loanedto: true }))).toBeUndefined();
  });

  it('keeps a player loaned IN, since they do play for this team', () => {
    const member = squadMemberFromSquadRow(row({ loanedto: false }));
    expect(member?.handle).toBe('Karaage');
    // Still not a starter: the role carries a label at all.
    expect(member?.isStarter).toBe(false);
  });

  it('keeps a player when the loan direction is absent entirely', () => {
    expect(squadMemberFromSquadRow(row(null))?.handle).toBe('Karaage');
  });
});

describe('squadMemberFromPlayerRow (v3/player fallback)', () => {
  // Shapes taken verbatim from Liquipedia's real response for Leviatán, the
  // team v3/squadplayer has no rows for at all.
  const playerRow = (over: Partial<LiquipediaPlayer>): LiquipediaPlayer => ({
    pagename: 'Devost',
    id: 'Devost',
    name: 'Julian Orozco',
    nationality: 'Colombia',
    status: 'Active',
    type: 'player',
    teampagename: 'Leviatán',
    extradata: { role: 'top', roles: { '1': 'top' } },
    ...over,
  });

  it('reads the position out of extradata.role, which v3/player has no column for', () => {
    expect(squadMemberFromPlayerRow(playerRow({}))).toEqual({
      handle: 'Devost',
      role: 'TOP',
      isStarter: true,
      startDate: null,
    });
  });

  it('maps every position Liquipedia uses for a starting role', () => {
    const cases: [string, string][] = [
      ['top', 'TOP'],
      ['jungle', 'JNG'],
      ['mid', 'MID'],
      ['bot', 'BOT'],
      ['support', 'SUP'],
    ];
    for (const [role, expected] of cases) {
      expect(squadMemberFromPlayerRow(playerRow({ extradata: { role } }))?.role).toBe(expected);
    }
  });

  it('excludes staff even when their secondary roles name real positions', () => {
    // Leviatán's active list really does contain Kouke: type "staff", primary
    // role "coach", but with "jungle" and "top" in the roles map. Filtering on
    // the role strings alone would field a coach as a starter.
    const kouke = playerRow({
      id: 'Kouke',
      type: 'staff',
      extradata: { role: 'coach', roles: { '1': 'coach', '2': 'jungle', '3': 'top' } },
    });
    expect(squadMemberFromPlayerRow(kouke)).toBeUndefined();
  });

  it('excludes a row with no resolvable position rather than guessing one', () => {
    expect(squadMemberFromPlayerRow(playerRow({ extradata: null }))).toBeUndefined();
    expect(squadMemberFromPlayerRow(playerRow({ extradata: { role: 'analyst' } }))).toBeUndefined();
  });
});

describe('squadMemberFromSquadRow (v3/squadplayer primary)', () => {
  const squadRow = (over: Partial<LiquipediaSquadPlayer>): LiquipediaSquadPlayer => ({
    pagename: 'Cloud9',
    id: 'Blaber',
    name: 'Robert Huang',
    nationality: 'United States',
    position: 'Jungle',
    role: '',
    type: 'player',
    status: 'active',
    joindate: '2019-11-29',
    ...over,
  });

  it('keeps the real join date when present', () => {
    expect(squadMemberFromSquadRow(squadRow({}))).toEqual({
      handle: 'Blaber',
      role: 'JNG',
      isStarter: true,
      startDate: '2019-11-29',
    });
  });

  it('treats Liquipedia\'s 0000-01-01 placeholder as no date, not a real one', () => {
    expect(squadMemberFromSquadRow(squadRow({ joindate: '0000-01-01' }))?.startDate).toBeNull();
    expect(squadMemberFromSquadRow(squadRow({ joindate: '' }))?.startDate).toBeNull();
  });

  it('carries the substitute flag through, unlike the v3/player fallback', () => {
    expect(squadMemberFromSquadRow(squadRow({ role: 'Substitute' }))?.isStarter).toBe(false);
  });

  it('excludes staff positions that are not a starting role', () => {
    expect(squadMemberFromSquadRow(squadRow({ position: 'Head Coach' }))).toBeUndefined();
  });
});
