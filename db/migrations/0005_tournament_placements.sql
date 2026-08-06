-- Final standings at international events.
--
-- Games tell us who beat whom; they do not tell us who won the tournament.
-- A team can go 6-4 and finish 3rd or 9th depending on bracket path, and the
-- board wants to show the finish, not reconstruct it.
--
-- `placement` is TEXT, not an integer, because Liquipedia reports shared
-- finishes as ranges -- "5-6", "7-8" -- wherever a bracket does not play out
-- third-place or consolation matches. Storing "5" for a team that actually
-- tied 5-6 would be a quiet lie, and the UI can render the range as-is.
CREATE TABLE tournament_placements (
  id SERIAL PRIMARY KEY,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  placement TEXT NOT NULL,
  -- Lowest number in the placement, for ordering. "5-6" sorts as 5.
  placement_sort INTEGER NOT NULL,
  prize_money NUMERIC,
  UNIQUE (tournament_id, team_id)
);

CREATE INDEX tournament_placements_team_idx ON tournament_placements (team_id);
