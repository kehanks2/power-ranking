-- Which games a generation was computed from, as a UTC game date.
--
-- computed_at answers "when did this run happen", which is the wrong question:
-- recomputing week-old data today writes a generation stamped today, so a
-- baseline chosen on computed_at would reject it for being newer than a match
-- day it does not actually contain. Selecting on the data frontier instead makes
-- the choice depend only on games, so recomputing any number of times leaves the
-- same baseline standing.
ALTER TABLE player_ratings_history
  ADD COLUMN data_frontier DATE;

-- Every existing generation was computed from the data we hold now.
UPDATE player_ratings_history
SET data_frontier = (SELECT max(datetime_utc)::date FROM games)
WHERE data_frontier IS NULL;

CREATE INDEX player_ratings_history_frontier_idx
  ON player_ratings_history (scope, rating_window, data_frontier DESC);

COMMENT ON COLUMN player_ratings_history.data_frontier IS
  'Newest game date this generation was computed from. Shared by every row of one run.';
