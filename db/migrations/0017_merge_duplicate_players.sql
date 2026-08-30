-- Merge four players that exist twice, splitting a roster row from their games.
--
-- populateRosterFromLiquipedia resolves a squad member by handle only
-- (`WHERE lower(handle) = lower($1)`) and mints `liquipedia:player:<handle>` on
-- a miss. Every player predating Liquipedia is keyed `oe:player:<hash>`, so any
-- spelling variance created a second identity: the roster row landed on the new
-- id and the games stayed on the old one. Neither row was complete, and the
-- board showed the empty half -- a 0-game row on the board while the row with
-- the real record was invisible for want of a league.
--
-- Adjudicated 2026-08-17; all four are one person. Sav1or/Shaoye is the
-- one no similarity rule would have caught.
--
-- The kept row is the one holding the game history, so ratings survive intact,
-- but it TAKES THE CURRENT LIQUIPEDIA HANDLE. That is what stops the duplicate
-- reappearing on the next roster import: the squad row's handle now matches the
-- surviving player, so the handle lookup resolves instead of minting again.
-- The general fix -- resolving on the Liquipedia page key -- is still open.
--
-- Rerunnable: the joins find nothing once the dropped rows are gone.
-- Ratings are a pure function of games, so RECOMPUTE AFTER APPLYING THIS.

BEGIN;

CREATE TEMP TABLE merge_pairs (keep_page text, drop_page text, final_handle text) ON COMMIT DROP;
INSERT INTO merge_pairs VALUES
  ('oe:player:c332dc879e14f1feb266190c7f396fd', 'liquipedia:player:Shadow', 'Shadow'),
  ('oe:player:6d734e1e86b978852d95cfd63d6a643', 'liquipedia:player:Sav1or', 'Sav1or'),
  ('oe:player:13166913111075999f2adeb687548eb', 'liquipedia:player:Palkia', 'Palkia'),
  ('oe:player:bc4f68ea698f26bb1e2f6d34f900f57', 'liquipedia:player:SamD',   'SamD');

CREATE TEMP TABLE merges ON COMMIT DROP AS
SELECT k.id AS keep_id, d.id AS drop_id, mp.final_handle
FROM merge_pairs mp
JOIN players k ON k.leaguepedia_page = mp.keep_page
JOIN players d ON d.leaguepedia_page = mp.drop_page;

-- A pair that resolves to one row would silently merge a player into themselves.
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM merges WHERE keep_id = drop_id;
  IF bad > 0 THEN RAISE EXCEPTION 'merge pair resolved to a single player id'; END IF;
END $$;

-- player_game_performance is UNIQUE (game_id, player_id), so a game played by
-- both halves of a pair would collide. Verified none is, but assert it rather
-- than trust the reading.
DO $$
DECLARE clashes int;
BEGIN
  SELECT count(*) INTO clashes
  FROM merges m
  JOIN player_game_performance a ON a.player_id = m.keep_id
  JOIN player_game_performance b ON b.player_id = m.drop_id AND b.game_id = a.game_id;
  IF clashes > 0 THEN RAISE EXCEPTION 'pair shares % game(s); merge would violate the unique key', clashes; END IF;
END $$;

UPDATE game_lineups gl SET player_id = m.keep_id
FROM merges m WHERE gl.player_id = m.drop_id;

UPDATE player_game_performance pgp SET player_id = m.keep_id
FROM merges m WHERE pgp.player_id = m.drop_id;

-- Rebuilt by the recompute that must follow, so the dropped id's snapshots are
-- discarded rather than repointed.
DELETE FROM player_ratings_history prh USING merges m WHERE prh.player_id = m.drop_id;

-- One membership per player: if the survivor already has the squad row, the
-- dropped id's is redundant rather than a second team.
DELETE FROM roster_memberships rm USING merges m
WHERE rm.player_id = m.drop_id
  AND EXISTS (SELECT 1 FROM roster_memberships k WHERE k.player_id = m.keep_id);

UPDATE roster_memberships rm SET player_id = m.keep_id
FROM merges m WHERE rm.player_id = m.drop_id;

UPDATE players p SET handle = m.final_handle
FROM merges m WHERE p.id = m.keep_id;

DELETE FROM players p USING merges m WHERE p.id = m.drop_id;

COMMIT;
