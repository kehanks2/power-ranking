-- Promotion play is not season play, so it should never have been rated.
--
-- `LCP 2026 Promotion` put eight games into the ratings: Deep Cross Gaming vs
-- Chiefs Esports Club and MVK Esports vs Saigon Dino, October 2025. Both LCP
-- sides are current board teams; neither opponent is tracked at all. A league
-- team playing an outsider for a slot is not a result the league's board is
-- measuring, and `isPromotionPlay` now excludes the whole class at ingestion,
-- so this clears what was taken before that guard existed.
--
-- Regional Finals are NOT touched. LCK/LPL Regional Finals are those leagues'
-- playoffs -- every participant is a current tracked team -- and their 38 games
-- stay. Matched on the page path rather than the tier, because tier does not
-- separate the two: LCP 2026 Promotion is tier 1 and LPL Regional Finals is
-- tier 2.
--
-- Re-runnable: matches nothing once applied. Follow with a recompute
-- (`npm run recompute --workspace=@power-ranking/ingestion`), or the rating
-- tables keep the eight games until the next daily run rebuilds them.

BEGIN;

CREATE TEMP TABLE promotion_tournaments ON COMMIT DROP AS
  SELECT id FROM tournaments
   WHERE overview_page ~ '(^|[:/])Promotion(_[A-Za-z]+)?(/|$)';

CREATE TEMP TABLE promotion_series ON COMMIT DROP AS
  SELECT id FROM series WHERE tournament_id IN (SELECT id FROM promotion_tournaments);

CREATE TEMP TABLE promotion_games ON COMMIT DROP AS
  SELECT id FROM games WHERE series_id IN (SELECT id FROM promotion_series);

DELETE FROM player_game_performance WHERE game_id IN (SELECT id FROM promotion_games);
DELETE FROM game_lineups            WHERE game_id IN (SELECT id FROM promotion_games);
DELETE FROM games                   WHERE id      IN (SELECT id FROM promotion_games);
DELETE FROM tournament_placements   WHERE tournament_id IN (SELECT id FROM promotion_tournaments);
DELETE FROM series                  WHERE id      IN (SELECT id FROM promotion_series);
DELETE FROM tournaments             WHERE id      IN (SELECT id FROM promotion_tournaments);

COMMIT;
