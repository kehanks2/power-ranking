import type { Role } from '@power-ranking/rating-engine';

/**
 * Shared between roster ingestion (populateRosterFromLiquipedia.ts) and match
 * ingestion (liquipediaMatchIngest.ts) -- both need to map our team names and
 * OE-derived role/position strings onto Liquipedia's own naming.
 */

// Our team rows carry Oracle's Elixir names, which don't always match
// Liquipedia's. Each entry confirmed against the Liquipedia API, not guessed;
// teams absent here that still fail to match are genuinely disbanded or
// unresolved on Liquipedia, and get logged as unmatched rather than forced.
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
 * Extra historical names -> our team name, for match ingestion only. Old series
 * reference a team by a name it has since dropped (older CBLOL matches say
 * "Fluxo", now "Fluxo W7M"); TEAM_NAME_ALIASES only covers current names, and
 * roster ingestion only ever needs those.
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
 * Liquipedia's free-text position -> our Role; undefined for
 * staff/unrecognized/missing. Some per-game entries omit `role`, so a
 * null/undefined must be skipped rather than crash the run.
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
