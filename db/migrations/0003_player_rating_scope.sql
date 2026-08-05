-- Player ratings now come in two flavours, and they are NOT comparable to
-- each other:
--
--   'regional'      -- percentile within (league, role). Meaningful only
--                      INSIDE one league: every league's distribution is
--                      centred on ~50 by construction, so a CBLOL 78 and an
--                      LCK 78 say nothing about which player is better.
--                      (Confirmed against real data: CBLOL's average rated
--                      player scored HIGHER than LCK's, while international
--                      results put CBLOL ~666 Elo BELOW LCK.)
--
--   'international' -- percentile within (role) across everyone who has
--                      actually played international games, computed from
--                      those games only. Cross-league comparable without any
--                      calibration factor, because the players in the pool
--                      genuinely played each other.
--
-- Kept in one table rather than two because every consumer wants "this
-- player's rating for the current view" and the scope is just which view.
ALTER TABLE player_ratings_history
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'regional';

ALTER TABLE player_ratings_history
  ADD CONSTRAINT player_ratings_history_scope_check
  CHECK (scope IN ('regional', 'international'));

-- Reads are always "latest row for this player in this scope", so scope has
-- to lead the existing (player_id, as_of_date) lookup.
DROP INDEX IF EXISTS player_ratings_history_player_id_as_of_date_idx;
CREATE INDEX player_ratings_history_scope_player_date_idx
  ON player_ratings_history (scope, player_id, as_of_date DESC);
