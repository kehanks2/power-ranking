-- Team ratings now come in two scopes, and they are NOT comparable to each
-- other -- nor, for the regional scope, comparable BETWEEN regions.
--
--   'overall'       -- the full replay: every game a team has played. Read as
--                      contextual-only, this ranks teams within one region.
--                      Two regions' numbers cannot be compared, because a
--                      team's contextual rating floats within its own league's
--                      pool. Measured: mean contextual offset by league spans
--                      only 85 points and is not even correctly ordered.
--
--   'international' -- replayed over cross-region games ONLY, with the league
--                      prior switched off entirely. No regional assumption
--                      enters it: these teams played each other directly, so
--                      this is the one scope that can rank across regions.
--
-- The league meta rating still exists and is still needed to grade
-- international games correctly during the replay, but it is no longer added
-- to any displayed team rating. It surfaces on its own, as regional strength.
ALTER TABLE team_ratings_history
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'overall';

ALTER TABLE team_ratings_history
  ADD CONSTRAINT team_ratings_history_scope_check
  CHECK (scope IN ('overall', 'international'));

-- Reads are always "latest row for this team in this scope".
DROP INDEX IF EXISTS team_ratings_history_team_id_as_of_date_idx;
CREATE INDEX team_ratings_history_scope_team_date_idx
  ON team_ratings_history (scope, team_id, as_of_date DESC);
