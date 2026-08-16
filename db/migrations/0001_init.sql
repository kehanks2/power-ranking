-- PowerRanking initial schema
-- See MODEL.md for the design rationale behind the rating tables.

CREATE TABLE leagues (
  id            SERIAL PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,   -- 'LCK','LPL','LEC','LCS','CBLOL','LCP'
  name          TEXT NOT NULL,
  logo_url      TEXT
);

-- Resolves a raw league/region string as it appears in Leaguepedia to a canonical league,
-- valid over a date range. Handles the LTAN->LCS / LTAS->CBLOL historical rename.
CREATE TABLE league_aliases (
  id                  SERIAL PRIMARY KEY,
  raw_league_name     TEXT NOT NULL,
  canonical_league_id INT NOT NULL REFERENCES leagues(id),
  valid_from          DATE NOT NULL,
  valid_to            DATE,             -- NULL = still in effect
  UNIQUE (raw_league_name, valid_from)
);

CREATE TABLE teams (
  id                  SERIAL PRIMARY KEY,
  leaguepedia_page    TEXT UNIQUE NOT NULL,  -- stable Leaguepedia OverviewPage; survives rebrands
  slug                TEXT UNIQUE NOT NULL,
  name                TEXT NOT NULL,
  short_name          TEXT,
  logo_url            TEXT,
  brand_color         TEXT                    -- for frontend team-accent theming
);

CREATE TABLE team_league_memberships (
  id          SERIAL PRIMARY KEY,
  team_id     INT NOT NULL REFERENCES teams(id),
  league_id   INT NOT NULL REFERENCES leagues(id),
  start_date  DATE NOT NULL,
  end_date    DATE                          -- NULL = current
);
CREATE INDEX ON team_league_memberships (team_id, end_date);
CREATE INDEX ON team_league_memberships (league_id, end_date);

CREATE TABLE players (
  id                SERIAL PRIMARY KEY,
  leaguepedia_page   TEXT UNIQUE NOT NULL,
  handle             TEXT NOT NULL,
  country            TEXT,
  photo_url          TEXT
);

-- Date-ranged roster membership. Labels only for MVP (is_starter, role) --
-- the actual roster-change *detection* that drives rating decay comes from
-- diffing per-game lineups (see player_game_performance), not this table.
CREATE TABLE roster_memberships (
  id          SERIAL PRIMARY KEY,
  team_id     INT NOT NULL REFERENCES teams(id),
  player_id   INT NOT NULL REFERENCES players(id),
  role        TEXT NOT NULL CHECK (role IN ('TOP','JNG','MID','BOT','SUP')),
  is_starter  BOOLEAN NOT NULL DEFAULT TRUE,
  start_date  DATE NOT NULL,
  end_date    DATE
);
CREATE INDEX ON roster_memberships (team_id, end_date);
CREATE INDEX ON roster_memberships (team_id, role, end_date);

CREATE TABLE tournaments (
  id                    SERIAL PRIMARY KEY,
  overview_page          TEXT UNIQUE NOT NULL,
  name                   TEXT NOT NULL,
  raw_league_name        TEXT NOT NULL,
  canonical_league_id    INT REFERENCES leagues(id),  -- NULL until resolved via league_aliases; never guessed
  tournament_type        TEXT NOT NULL CHECK (tournament_type IN ('regional_split','international','playoffs')),
  date_start             DATE NOT NULL,
  date_end               DATE
);
CREATE INDEX ON tournaments (canonical_league_id, date_start);

CREATE TABLE series (
  id                    SERIAL PRIMARY KEY,
  tournament_id          INT NOT NULL REFERENCES tournaments(id),
  leaguepedia_match_id    TEXT UNIQUE NOT NULL,
  team1_id                INT NOT NULL REFERENCES teams(id),
  team2_id                INT NOT NULL REFERENCES teams(id),
  best_of                 INT,
  team1_score             INT,
  team2_score             INT,
  winner_team_id          INT REFERENCES teams(id),
  is_international        BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE games (
  id                      SERIAL PRIMARY KEY,
  series_id                INT NOT NULL REFERENCES series(id),
  leaguepedia_unique_line   TEXT UNIQUE NOT NULL,  -- idempotency key
  game_number               INT NOT NULL,
  team1_id                  INT NOT NULL REFERENCES teams(id),
  team2_id                  INT NOT NULL REFERENCES teams(id),
  winner_team_id             INT NOT NULL REFERENCES teams(id),
  datetime_utc               TIMESTAMPTZ NOT NULL,
  patch                      TEXT,
  team1_gold                 INT,             -- for margin-of-victory weighting
  team2_gold                 INT,
  gamelength_seconds          INT
);
CREATE INDEX ON games (datetime_utc);
CREATE INDEX ON games (series_id);

-- Actual per-game lineup, keyed off ScoreboardPlayers. This is the ground-truth
-- signal that drives roster-change detection (see rating-engine/rosterChange.ts) --
-- roster_memberships above is derived from this, not the other way around.
CREATE TABLE game_lineups (
  id            SERIAL PRIMARY KEY,
  game_id       INT NOT NULL REFERENCES games(id),
  team_id       INT NOT NULL REFERENCES teams(id),
  player_id     INT NOT NULL REFERENCES players(id),
  role          TEXT NOT NULL CHECK (role IN ('TOP','JNG','MID','BOT','SUP')),
  UNIQUE (game_id, team_id, role)
);
CREATE INDEX ON game_lineups (team_id, role, game_id);

CREATE TABLE player_game_performance (
  id                SERIAL PRIMARY KEY,
  game_id           INT NOT NULL REFERENCES games(id),
  player_id         INT NOT NULL REFERENCES players(id),
  team_id           INT NOT NULL REFERENCES teams(id),
  role              TEXT NOT NULL CHECK (role IN ('TOP','JNG','MID','BOT','SUP')),
  kills             INT,
  deaths            INT,
  assists           INT,
  gold              INT,
  damage_to_champions INT,
  composite_score    NUMERIC,   -- 0-100, role+league-normalized percentile composite
  UNIQUE (game_id, player_id)
);

CREATE TABLE rating_periods (
  id            SERIAL PRIMARY KEY,
  period_start   DATE NOT NULL UNIQUE,
  period_end     DATE NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','computed'))
);

CREATE TABLE team_ratings_history (
  id                SERIAL PRIMARY KEY,
  team_id           INT NOT NULL REFERENCES teams(id),
  rating_period_id  INT REFERENCES rating_periods(id),  -- NULL for decay events (as_of_date still set)
  as_of_date        DATE NOT NULL,
  mu_ctx            NUMERIC NOT NULL,
  phi_ctx           NUMERIC NOT NULL,
  sigma_ctx         NUMERIC NOT NULL,
  reason            TEXT NOT NULL CHECK (reason IN ('initial','game_update','roster_decay','seasonal_decay')),
  roster_implied_mu NUMERIC,   -- audit trail for roster_decay rows: what the player-implied prior computed to
  flat_mean_mu      NUMERIC,   -- audit trail for roster_decay rows: what the flat league-mean fallback would have been
  method_version    INT NOT NULL
);
CREATE INDEX ON team_ratings_history (team_id, as_of_date);

CREATE TABLE league_ratings_history (
  id             SERIAL PRIMARY KEY,
  league_id      INT NOT NULL REFERENCES leagues(id),
  as_of_date     DATE NOT NULL,
  mu_meta        NUMERIC NOT NULL,
  phi_meta       NUMERIC NOT NULL,
  sigma_meta     NUMERIC NOT NULL,
  method_version INT NOT NULL
);
CREATE INDEX ON league_ratings_history (league_id, as_of_date);

CREATE TABLE player_ratings_history (
  id             SERIAL PRIMARY KEY,
  player_id      INT NOT NULL REFERENCES players(id),
  as_of_date     DATE NOT NULL,
  rating         NUMERIC NOT NULL,   -- EWMA of composite_score, 0-100 scale
  games_played   INT NOT NULL,
  method_version INT NOT NULL
);
CREATE INDEX ON player_ratings_history (player_id, as_of_date);

-- Tuned constants for the rating engine, versioned so historical rows stay
-- reproducible after retuning. Exactly one row should have is_active = TRUE.
CREATE TABLE rating_config (
  method_version        INT PRIMARY KEY,
  phi_init_max           NUMERIC NOT NULL DEFAULT 2.014761872416068, -- ~350 on the 1500-centered display scale
  sigma_default           NUMERIC NOT NULL DEFAULT 0.06,
  margin_scale             NUMERIC NOT NULL DEFAULT 15,    -- gold-diff-per-minute scale for MOV weighting
  mov_weight_cap            NUMERIC NOT NULL DEFAULT 1.5,
  k_season                  NUMERIC NOT NULL DEFAULT 0.25, -- seasonal soft-decay mu regression factor
  offset_scale               NUMERIC NOT NULL DEFAULT 150, -- player percentile -> team-rating-scale points
  roster_change_min_games     INT NOT NULL DEFAULT 10,     -- player games-played confidence threshold
  roster_change_persistence_games INT NOT NULL DEFAULT 2,  -- consecutive games before a lineup swap counts
  is_active                    BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE ingestion_runs (
  id            SERIAL PRIMARY KEY,
  run_type      TEXT NOT NULL CHECK (run_type IN ('ingest_cargo','compute_ratings')),
  started_at    TIMESTAMPTZ NOT NULL,
  finished_at   TIMESTAMPTZ,
  watermark_utc TIMESTAMPTZ,
  status        TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  error_message TEXT
);
