-- Liquipedia's stage marker for a series (match2bracketid), e.g. "LCK26Sp3W3"
-- for a regular-season week or "LCS26SPRPO" for a playoff bracket.
--
-- Stored so a board can advance once a whole week of play is in, rather than
-- after each match day: a team that plays Saturday jumps a rival who plays
-- Sunday and falls back the next day, which is an artefact of the schedule
-- rather than evidence. The stage is also the only reliable signal separating
-- round-robin play from brackets, where every series IS decisive and the board
-- should move immediately.
--
-- Nullable: series ingested before this column existed have no marker until
-- backfilled, and Liquipedia has occasionally returned an empty id.

ALTER TABLE series ADD COLUMN bracket_id TEXT;

-- The advancement check asks "does this league's current stage still have
-- unfinished series", which reads by stage across a tournament.
CREATE INDEX series_tournament_bracket_idx ON series (tournament_id, bracket_id);
