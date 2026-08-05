import type { Role } from '@power-ranking/rating-engine';

/**
 * Shared between roster ingestion (populateRosterFromLiquipedia.ts) and match
 * ingestion (liquipediaMatchIngest.ts) -- both need to map our team names and
 * OE-derived role/position strings onto Liquipedia's own naming.
 */

// Our team names come from Oracle's Elixir (often with a current sponsor
// prefix/suffix); Liquipedia's names don't always match exactly. Confirmed
// individually against the Liquipedia API (not guessed) -- teams NOT in this
// map that still fail to match were checked too and are genuinely disbanded
// on Liquipedia (e.g. Immortals, 100 Thieves, PSG Talon, Liberty, QT DIG∞) or
// unresolved (Team BDS, Movistar R7, MGN Vikings Esports, Saving OCE -- no
// matching page found under any name guessed; logged as unmatched rather
// than silently forced).
export const TEAM_NAME_ALIASES: Record<string, string> = {
  'Gen.G': 'Gen.G Esports',
  'Kiwoom DRX': 'DRX',
  'HANJIN BRION': 'BRION',
  'DN SOOPers': 'SOOPers',
  'BNK FEARX': 'FEARX',
  'MAD Lions KOI': 'Movistar KOI',
  Fluxo: 'Fluxo W7M',
  'Dplus Kia': 'Dplus',
  'Vivo Keyd Stars': 'Keyd Stars',
  Leviatan: 'Leviatán',
  GiantX: 'GIANTX',
  'LØS': 'LOS',
  'Team Secret Whales': 'Secret Whales',
};

/**
 * Historical match records can reference a team by a name it no longer goes
 * by (e.g. before picking up a sponsor) -- confirmed against real data
 * ingesting CBLOL's full 2.5-year history: match opponents literally say
 * "Fluxo" for older series even though the team's current Liquipedia name is
 * "Fluxo W7M" (TEAM_NAME_ALIASES above, which only covers the CURRENT name).
 * This is a separate, additive map of extra names -> our team name, used
 * only for match-ingestion team resolution (roster ingestion only ever needs
 * the current name).
 */
export const HISTORICAL_LIQUIPEDIA_NAME_ALIASES: Record<string, string> = {
  Fluxo: 'Fluxo W7M',
  'MAD Lions KOI': 'Movistar KOI',
};

const POSITION_TO_ROLE: Record<string, Role> = {
  top: 'TOP',
  jungle: 'JNG',
  jng: 'JNG',
  mid: 'MID',
  middle: 'MID',
  bot: 'BOT',
  bottom: 'BOT',
  adc: 'BOT',
  support: 'SUP',
  supp: 'SUP',
  sup: 'SUP',
};

/**
 * Maps Liquipedia's free-text position/role string to our Role enum;
 * undefined for staff/unrecognized/missing values. Defensively accepts
 * null/undefined -- confirmed against real match data some per-game player
 * entries omit `role` entirely (e.g. an incomplete/placeholder record),
 * which must be skipped rather than crash the whole ingestion run.
 */
export function resolvePosition(position: string | null | undefined): Role | undefined {
  if (!position) return undefined;
  return POSITION_TO_ROLE[position.trim().toLowerCase()];
}

/** Resolves our team name to its Liquipedia name, applying TEAM_NAME_ALIASES first. */
export function ourNameToLiquipediaName(ourTeamName: string): string {
  return TEAM_NAME_ALIASES[ourTeamName] ?? ourTeamName;
}

/** Resolves our team name to Liquipedia's pagename, applying TEAM_NAME_ALIASES first. */
export function resolveTeamPagename(ourTeamName: string, pagenameByLiquipediaName: Map<string, string>): string | undefined {
  return pagenameByLiquipediaName.get(ourNameToLiquipediaName(ourTeamName));
}
