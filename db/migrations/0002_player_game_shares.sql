-- Adds the per-game share stats needed for the player composite score.
-- Oracle's Elixir precomputes gold/damage share per player-game, so we store
-- their values directly rather than recomputing from team totals ourselves.
ALTER TABLE player_game_performance
  ADD COLUMN gold_share NUMERIC,
  ADD COLUMN damage_share NUMERIC,
  ADD COLUMN kill_participation NUMERIC;
