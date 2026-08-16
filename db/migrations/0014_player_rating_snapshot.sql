-- Gives each recompute a distinct identity so player ratings can accumulate
-- generations, which is what rank-change carets read for a prior board.
--
-- `as_of_date` is a DATE and every row a run writes carries the same one, so
-- two recomputes on one day are indistinguishable and the board queries pinning
-- with `ORDER BY as_of_date DESC LIMIT 1` would pick between them arbitrarily.
ALTER TABLE player_ratings_history
  ADD COLUMN computed_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Existing rows are one run, written before generations existed.
UPDATE player_ratings_history SET computed_at = as_of_date + INTERVAL '12 hours';

CREATE INDEX player_ratings_history_generation_idx
  ON player_ratings_history (scope, rating_window, computed_at DESC);

COMMENT ON COLUMN player_ratings_history.computed_at IS
  'When the run that wrote this row computed it. Shared by every row of one run, and the generation key.';
