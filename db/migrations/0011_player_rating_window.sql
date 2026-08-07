-- Records WHICH stretch of play a player rating was computed over.
--
-- The regional board answers "how good is this player in this league", which
-- until now always meant "over everything we hold, recency-weighted". That is
-- the right default and a bad fit for the two questions people actually bring
-- to a player board in season -- All-Pro and MVP -- because both are awards
-- for a specific stretch, and a career-shaped rating with a 120-day half-life
-- is not the same thing as "who has been best this split".
--
--   'all'   -- everything, recency-weighted. The default and the only window
--              the international board has, since international events are
--              sparse enough that slicing them by split would leave nothing.
--   'year'  -- the calendar year the league's current split sits in.
--   'split' -- that league's current split only.
--
-- Both bounded windows are per-league, keyed off each league's own latest
-- split start rather than a global date: the leagues do not run on the same
-- calendar, and a shared cutoff would give one region three months of play and
-- another three days.
--
-- Kept in one table for the same reason `scope` is: every consumer wants "this
-- player's rating for the current view", and the window is just which view.
ALTER TABLE player_ratings_history
  ADD COLUMN rating_window TEXT NOT NULL DEFAULT 'all';

ALTER TABLE player_ratings_history
  ADD CONSTRAINT player_ratings_history_window_check
  CHECK (rating_window IN ('all', 'year', 'split'));

-- Named rating_window, not window: `window` is a reserved word (WINDOW
-- clauses), so a bare column of that name needs quoting at every use site.

-- Every lookup now names a window as well as a scope, so it leads the keys.
DROP INDEX IF EXISTS player_ratings_history_group_idx;
CREATE INDEX player_ratings_history_group_idx
  ON player_ratings_history (scope, rating_window, league_id, role, player_id);

DROP INDEX IF EXISTS player_ratings_history_primary_idx;
CREATE INDEX player_ratings_history_primary_idx
  ON player_ratings_history (scope, rating_window, player_id) WHERE is_primary;

COMMENT ON COLUMN player_ratings_history.rating_window IS
  'Which stretch of play the rating was computed over: all | year | split.';
