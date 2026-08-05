-- Seed the 6 major leagues (MVP scope) and their raw-name -> canonical mapping,
-- including the LTAN->LCS / LTAS->CBLOL historical remap.
-- See "How the official ranking works" / league_aliases design in the plan doc.

INSERT INTO leagues (slug, name) VALUES
  ('LCK',   'LCK'),
  ('LPL',   'LPL'),
  ('LEC',   'LEC'),
  ('LCS',   'LCS'),
  ('CBLOL', 'CBLOL'),
  ('LCP',   'LCP');

-- Non-expiring identity mappings (raw name === canonical slug for the whole history
-- except during the LTA-merged window below).
INSERT INTO league_aliases (raw_league_name, canonical_league_id, valid_from, valid_to)
SELECT slug, id, '2010-01-01', NULL FROM leagues;

-- The LTA merge (2025) split NA into LTA North and BR into LTA South.
-- LTA was reverted for 2026: LCS and CBLOL are canonical again, but historical
-- data from that window is filed under this raw region label. Confirmed
-- against real Oracle's Elixir 2025 data: the actual raw string is "LTA N" /
-- "LTA S" (with a space) -- also aliasing the no-space "LTAN"/"LTAS" variants
-- in case another source (e.g. Leaguepedia directly) uses that form.
INSERT INTO league_aliases (raw_league_name, canonical_league_id, valid_from, valid_to)
VALUES
  ('LTA N', (SELECT id FROM leagues WHERE slug = 'LCS'),   '2025-01-01', '2025-12-31'),
  ('LTA S', (SELECT id FROM leagues WHERE slug = 'CBLOL'), '2025-01-01', '2025-12-31'),
  ('LTAN',  (SELECT id FROM leagues WHERE slug = 'LCS'),   '2025-01-01', '2025-12-31'),
  ('LTAS',  (SELECT id FROM leagues WHERE slug = 'CBLOL'), '2025-01-01', '2025-12-31');

-- Also alias the merged "LTA" name itself in case a tournament page used the
-- unsplit region label rather than LTAN/LTAS directly. Ambiguous between LCS/CBLOL,
-- so left unresolved (NULL-mapped) deliberately -- ingestion must fall back to
-- per-team roster data to disambiguate rather than guessing here.

INSERT INTO rating_config (method_version) VALUES (1);
