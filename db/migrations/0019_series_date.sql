-- A series' own date, rather than deriving it from its games.
--
-- The team page showed a dated-blank row: FlyQuest 0-2 Cloud9 in LCS 2026
-- Summer rendered with no date at all. The date came from
-- MIN(games.datetime_utc), and that series has no game rows -- `shouldWaitForStats`
-- withholds a finished series' GAMES over a publication lag while the series
-- itself, with its scoreline and winner, is already stored. Five series are in
-- that state at any time.
--
-- Liquipedia dates a series by its start and every game in a series shares that
-- one timestamp, so this is not a second source of truth that can disagree with
-- the games -- it is the same value, stored where it belongs.

BEGIN;

ALTER TABLE series ADD COLUMN date_utc TIMESTAMPTZ;

-- Every series that has games: identical to what the API was computing.
UPDATE series s
SET date_utc = g.started_at
FROM (SELECT series_id, MIN(datetime_utc) AS started_at FROM games GROUP BY series_id) g
WHERE g.series_id = s.id;

-- The rest fill in on the next pull, which re-ingests recent dates and now
-- writes this column. Nothing is invented here.

CREATE INDEX series_date_idx ON series (date_utc);

COMMIT;
