-- Unplayed and drawn series were being handed a winner.
--
-- The ingest wrote `team1Score >= team2Score ? team1Id : team2Id`, and
-- Liquipedia reports a scheduled-but-unplayed match as -1 to -1. Both sides of
-- that comparison are equal, so every fixture on the calendar was recorded as
-- a win for whichever team happened to be listed first: 142 of them, one for
-- every remaining game of the 2026 season.
--
-- Nothing read it, because every rating and every record on the site is built
-- from GAMES and an unplayed series has none. It surfaces the moment anything
-- counts series -- which the team page now does -- so it is fixed here rather
-- than worked around in that query.
--
-- A drawn Bo2 (1-1) is caught by the same rule: it has no winner either, and
-- `>=` was giving it to team1 as well.
UPDATE series
SET winner_team_id = NULL
WHERE team1_score IS NULL
   OR team2_score IS NULL
   OR team1_score < 0
   OR team2_score < 0
   OR team1_score = team2_score;
