/**
 * Diagnostic: how quickly Liquipedia publishes a finished series. Read-only --
 * it never writes, so it is safe to point at a day we are deliberately not
 * ingesting yet.
 *
 * Run with: tsx <this file> "<SeriesName>" <YYYY-MM-DD>
 */
import { fetchMatches } from '../liquipediaApi.js';

const [seriesName, day] = process.argv.slice(2);
if (!seriesName || !day) {
  console.error('Usage: tsx checkLiquipediaFreshness.ts "<SeriesName>" <YYYY-MM-DD>');
  process.exit(1);
}

async function main() {
  const nextDay = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const matches = await fetchMatches(`[[series::${seriesName}]] AND [[date::>${day}]] AND [[date::<${nextDay}]]`);
  console.log(`now (UTC): ${new Date().toISOString()}`);
  console.log(`${matches.length} series returned for ${seriesName} on ${day}\n`);

  for (const match of matches) {
    const [a, b] = match.match2opponents ?? [];
    const games = match.match2games ?? [];
    const withWinner = games.filter((g) => g.winner !== null && g.winner !== undefined && String(g.winner) !== '');
    console.log(
      `${match.date}  ${a?.name ?? '?'} ${a?.score ?? '-'} - ${b?.score ?? '-'} ${b?.name ?? '?'}` +
        `  | games listed: ${games.length}, with a winner: ${withWinner.length}` +
        `  | finished: ${match.finished ?? 'n/a'}`,
    );
  }
}

main().catch((err) => {
  console.error('Freshness check failed:', err);
  process.exit(1);
});
