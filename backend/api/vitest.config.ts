import { defineConfig } from 'vitest/config';
import { testDatabaseUrl } from '../testDatabaseUrl.mjs';

export default defineConfig({
  test: {
    // Forced, and deliberately ignoring an ambient DATABASE_URL: these tests run
    // against a live database, and the ingestion suite wipes and rebuilds the
    // rating tables. Pointed at dev they silently destroy real ratings -- which
    // is how a real ingested generation of player_ratings_history was lost.
    env: { DATABASE_URL: testDatabaseUrl() },

    // Starts in-process PGlite unless TEST_DATABASE_URL opts out.
    globalSetup: ['../pgliteGlobalSetup.mjs'],

    // Generous for the opt-out path, where the database is hosted and every
    // query pays a network round trip: tests walking a board team by team run
    // ~12 requests deep and pass 5s on latency alone. Against PGlite the same
    // tests pay nothing, so this only ever costs a slow failure.
    testTimeout: 30_000,
  },
});
