import { defineConfig } from 'vitest/config';
import { testDatabaseUrl } from '../testDatabaseUrl.mjs';

export default defineConfig({
  test: {
    // Integration tests here share ONE live Postgres database with global,
    // unscoped tables (team_ratings_history etc. get fully wiped and
    // rebuilt by computeRatings/populateRosterMemberships, no per-test
    // scoping). Vitest's default parallel-file execution let two such tests
    // race against each other in practice: one test's full wipe-and-rebuild
    // landed mid-flight of another test's setup/teardown, and running the
    // suite silently left team_ratings_history empty afterward. Running
    // test files sequentially against the shared DB is the fix -- these are
    // integration tests validating real DB behavior, not isolated units,
    // so parallelism isn't safe here regardless of speed cost.
    fileParallelism: false,

    // Forced, and deliberately ignoring an ambient DATABASE_URL: the wipe above
    // destroys real ratings when this points at dev, which is how an ingested
    // generation of player_ratings_history was lost.
    env: { DATABASE_URL: testDatabaseUrl() },
  },
});
