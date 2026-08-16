import { defineConfig } from 'vitest/config';
import { testDatabaseUrl } from '../testDatabaseUrl.mjs';

export default defineConfig({
  test: {
    // Forced, and deliberately ignoring an ambient DATABASE_URL: these tests run
    // against a live database, and the ingestion suite wipes and rebuilds the
    // rating tables. Pointed at dev they silently destroy real ratings -- which
    // is how a real ingested generation of player_ratings_history was lost.
    env: { DATABASE_URL: testDatabaseUrl() },

    // The test database is hosted, so every query pays a network round trip
    // where a local socket paid none. Tests walking a board team by team run
    // ~12 requests deep and pass 5s on latency alone, having nothing to do
    // with what they assert.
    testTimeout: 30_000,
  },
});
