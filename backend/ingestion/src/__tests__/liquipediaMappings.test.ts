import { describe, it, expect } from 'vitest';
import { resolvePosition, resolveTeamPagename } from '../liquipediaMappings.js';

describe('resolvePosition', () => {
  it('maps the standard Liquipedia position strings to our Role enum', () => {
    expect(resolvePosition('Top')).toBe('TOP');
    expect(resolvePosition('Jungle')).toBe('JNG');
    expect(resolvePosition('Mid')).toBe('MID');
    expect(resolvePosition('Bot')).toBe('BOT');
    expect(resolvePosition('Support')).toBe('SUP');
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(resolvePosition('  TOP  ')).toBe('TOP');
    expect(resolvePosition('jungle')).toBe('JNG');
  });

  it('returns undefined for staff titles and unrecognized positions', () => {
    expect(resolvePosition('Head Coach')).toBeUndefined();
    expect(resolvePosition('Owner/Founder')).toBeUndefined();
    expect(resolvePosition('')).toBeUndefined();
  });

  it('does not throw on null/undefined -- some match records omit role entirely', () => {
    expect(resolvePosition(null)).toBeUndefined();
    expect(resolvePosition(undefined)).toBeUndefined();
  });
});

describe('resolveTeamPagename', () => {
  it("matches directly when our team name equals Liquipedia's name exactly", () => {
    const map = new Map([['Cloud9', 'Cloud9']]);
    expect(resolveTeamPagename('Cloud9', map)).toBe('Cloud9');
  });

  it('applies the known sponsor-prefix alias table before matching', () => {
    const map = new Map([['DRX', 'DRX']]);
    expect(resolveTeamPagename('Kiwoom DRX', map)).toBe('DRX');
  });

  it('applies the confirmed rebrand alias (MAD Lions KOI -> Movistar KOI)', () => {
    const map = new Map([['Movistar KOI', 'Movistar_KOI']]);
    expect(resolveTeamPagename('MAD Lions KOI', map)).toBe('Movistar_KOI');
  });

  it('returns undefined for a team with no match at all (e.g. genuinely disbanded)', () => {
    const map = new Map([['Cloud9', 'Cloud9']]);
    expect(resolveTeamPagename('Immortals', map)).toBeUndefined();
  });
});
