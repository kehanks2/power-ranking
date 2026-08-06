-- Records WHICH peer group a player rating was computed in.
--
-- The rating has always been a percentile within a (league, role) group, but
-- only the resulting number was stored. That left two things unfixable:
--
--   * The board's Games column and the detail panel disagreed. The column came
--     from the one group the rating chose; the panel aggregated every game the
--     player had. Berserker reads 130 on the board (LCS) against 218 played
--     (130 LCS + 88 LCK).
--
--   * A regional board could rate a player on a league they no longer play in.
--     Six of 324 rostered players are currently rated on games from a different
--     league than the board they appear on -- their rating answers a question
--     about a league they left.
--
-- So a player now gets one row per group they have games in, and reads pick
-- the group they actually mean. league_id is NULL for international ratings:
-- that pool has no league dimension at all by design, peer groups there are
-- role-only, which is exactly what makes it cross-region comparable.
ALTER TABLE player_ratings_history
  ADD COLUMN league_id INT REFERENCES leagues(id),
  ADD COLUMN role      TEXT,
  ADD COLUMN is_primary BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE player_ratings_history
  ADD CONSTRAINT player_ratings_history_role_check
  CHECK (role IS NULL OR role IN ('TOP','JNG','MID','BOT','SUP'));

-- The group with the most recency-weighted games -- what the single stored row
-- used to be. Consumers wanting "this player's rating" with no league in mind
-- (the roster-implied prior for team ratings) read this and keep their old
-- behaviour, rather than letting DISTINCT ON pick between groups arbitrarily.
COMMENT ON COLUMN player_ratings_history.is_primary IS
  'The group backed by the most recency-weighted games; one per (player, scope).';

-- Boards look up a specific group; the prior looks up the primary one.
CREATE INDEX player_ratings_history_group_idx
  ON player_ratings_history (scope, league_id, role, player_id);
CREATE INDEX player_ratings_history_primary_idx
  ON player_ratings_history (scope, player_id) WHERE is_primary;
