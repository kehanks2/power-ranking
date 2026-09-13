/**
 * Asks Liquipedia whether the games we hold a scoreboard for but no draft
 * actually have one upstream. One request: the ids are OR'd together the way
 * refreshStatlessGames does.
 *
 *   npx tsx --env-file=../../.env src/checkDraftGaps.ts
 */
import { fetchMatches, bansFromExtradata } from './liquipediaApi.js';
import { matchIdConditions } from './refreshStatlessGames.js';

const MATCH_IDS = [
  '26LPLS3RS3_0007',
  'CBLOL26S24_0004',
  '26LPLS3KnR_R01-M002',
  'LCK2026POB_R01-M001',
  'CBLOL26E2P_R01-M002',
];

const matches = await fetchMatches(matchIdConditions(MATCH_IDS));
console.log(`${matches.length} matches returned\n`);

for (const match of matches) {
  console.log(`${match.match2id}  (${match.tournament})`);
  for (const game of match.match2games ?? []) {
    const characters = (game.opponents ?? []).flatMap((o) =>
      (o.players ?? []).map((p) => p.character).filter(Boolean),
    );
    const bans = bansFromExtradata(game.extradata);
    const extraKeys = Object.keys(game.extradata ?? {});
    console.log(
      `  game ${game.match2gameid}: ${characters.length} characters, ${bans.length} bans` +
        `, extradata keys: ${extraKeys.length ? extraKeys.slice(0, 12).join(',') : '(none)'}`,
    );
  }
  console.log('');
}
