-- Schema that nothing reads and nothing has ever written.
--
-- rating_config was meant to hold tunable rating parameters, but every value
-- is a hardcoded constant in TypeScript and the table was never consulted.
-- Worse, the two had silently diverged: margin_scale read 15 here against 1e9
-- in code, and roster_change_persistence_games read 2 against 5. Anyone tuning
-- this table would have seen no effect whatsoever. The constants stay in code,
-- where their provenance is documented -- see MODEL.md.
DROP TABLE IF EXISTS rating_config;

-- Never written to: 0 rows, 0 code references.
DROP TABLE IF EXISTS ingestion_runs;

-- The column first, because it carries the foreign key into the table.
-- Both are unused: 0 rows in rating_periods, and every rating_period_id is
-- NULL across all 6,299 team rating rows. Rating periods are a replay-time
-- concept that never needed persisting.
ALTER TABLE team_ratings_history DROP COLUMN IF EXISTS rating_period_id;
DROP TABLE IF EXISTS rating_periods;

-- Always NULL, never referenced. flat_mean_mu was to sit alongside
-- roster_implied_mu as the cold-start comparison; composite_score was to cache
-- the player composite that computePlayerRatings recalculates from source
-- every run. Neither was ever populated.
ALTER TABLE team_ratings_history DROP COLUMN IF EXISTS flat_mean_mu;
ALTER TABLE player_game_performance DROP COLUMN IF EXISTS composite_score;
