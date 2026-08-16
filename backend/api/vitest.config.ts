import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Forced, and deliberately ignoring an ambient DATABASE_URL: these tests run
    // against a live database, and the ingestion suite wipes and rebuilds the
    // rating tables. Pointed at dev they silently destroy real ratings -- which
    // is how a real ingested generation of player_ratings_history was lost.
    // Seed the clone with: CREATE DATABASE powerranking_test TEMPLATE powerranking;
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? 'postgresql://powerranking:powerranking@localhost:5433/powerranking_test',
    },
  },
});
