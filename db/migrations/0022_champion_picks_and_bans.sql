-- Champion draft data: picks ride on the existing per-player stat line, bans get
-- their own table because they belong to a team in a game and name no player.
ALTER TABLE player_game_performance ADD COLUMN champion TEXT;

CREATE INDEX ON player_game_performance (champion);

CREATE TABLE game_bans (
  id        SERIAL PRIMARY KEY,
  game_id   INT NOT NULL REFERENCES games(id),
  team_id   INT NOT NULL REFERENCES teams(id),
  ban_order INT NOT NULL,
  champion  TEXT NOT NULL,
  UNIQUE (game_id, team_id, ban_order)
);
CREATE INDEX ON game_bans (champion);
CREATE INDEX ON game_bans (game_id);
