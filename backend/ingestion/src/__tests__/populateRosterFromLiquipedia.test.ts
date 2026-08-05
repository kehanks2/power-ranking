import { describe, it, expect } from 'vitest';
import { isStarterFromRole } from '../populateRosterFromLiquipedia.js';

describe('isStarterFromRole', () => {
  it('treats an empty role as a current starter', () => {
    expect(isStarterFromRole('')).toBe(true);
  });

  it('treats "Substitute" (any casing/whitespace) as NOT a starter', () => {
    expect(isStarterFromRole('Substitute')).toBe(false);
    expect(isStarterFromRole('substitute')).toBe(false);
    expect(isStarterFromRole('  SUBSTITUTE  ')).toBe(false);
  });

  it('treats other tags like "Loan" or "Captain" as a starter', () => {
    expect(isStarterFromRole('Loan')).toBe(true);
    expect(isStarterFromRole('Captain')).toBe(true);
  });

  it('does not throw on null/undefined -- defensively treats as a starter', () => {
    expect(isStarterFromRole(null)).toBe(true);
    expect(isStarterFromRole(undefined)).toBe(true);
  });
});
