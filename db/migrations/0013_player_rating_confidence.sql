-- Keeps the two numbers behind the shrink, so the board can show how much of a
-- rating the games have actually earned.
--
-- `rating` is already a shrunk value: the blended percentile pulled toward an
-- anchor (neutral 50, or a transfer anchor) by w = effective_games /
-- (effective_games + k). A reader sees only the shrunk number, so a 66 off eight
-- games and a 66 off three hundred look identical on the board.
--
-- Neither input can be recovered from what was stored. `games_played` is the raw
-- count, but the shrink runs on the recency-weighted `effective_games`, and a
-- transferred player is shrunk toward their other league's carryover rather than
-- 50 -- so inverting the formula from games_played would draw a projection the
-- model does not make.
--
-- Nullable: rows written before this migration have neither, and a reader must
-- be able to tell "not recorded" from a real 0 (a player with no games has an
-- honest effective_games of 0).
ALTER TABLE player_ratings_history
  ADD COLUMN raw_rating      NUMERIC,
  ADD COLUMN effective_games NUMERIC;

COMMENT ON COLUMN player_ratings_history.raw_rating IS
  'The blended composite percentile before shrinkage -- where the rating settles if this form holds.';
COMMENT ON COLUMN player_ratings_history.effective_games IS
  'Recency-weighted game count the shrink was computed from; always <= games_played.';
