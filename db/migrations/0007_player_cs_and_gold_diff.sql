-- Per-game economy stats for the player detail panel.
--
-- creep_score is stored raw rather than as CS/min, because the minutes come
-- from games.gamelength_seconds, which Liquipedia leaves null on a small number
-- of games. Deriving the rate at read time lets those games show as unknown
-- instead of silently dividing by a wrong or missing duration.
--
-- gold_diff is against the SAME-ROLE opponent in that game -- the standard
-- lane-differential reading, and computable at ingest because Liquipedia
-- returns both lineups with roles. It is null when the opposing role cannot be
-- resolved to exactly one player, which happens on the handful of games with
-- malformed or duplicated position data.
ALTER TABLE player_game_performance
  ADD COLUMN creep_score INTEGER,
  ADD COLUMN gold_diff   INTEGER;
