-- Reference rows the migrations deliberately do not create: in production these
-- arrive with the first ingest. A schema built from migrations alone has none,
-- so anything resolving a league name gets NULL and hits a NOT NULL constraint.
--
-- Mirrors the live tables exactly. The LTA aliases are closed-ended on purpose:
-- LTA N/S ran for 2025 only, and folded back into LCS/CBLOL.

INSERT INTO leagues (id, slug, name, logo_url) VALUES
  (1, 'LCK',   'LCK',   NULL),
  (2, 'LPL',   'LPL',   NULL),
  (3, 'LEC',   'LEC',   NULL),
  (4, 'LCS',   'LCS',   NULL),
  (5, 'CBLOL', 'CBLOL', NULL),
  (6, 'LCP',   'LCP',   NULL);

INSERT INTO league_aliases (id, raw_league_name, canonical_league_id, valid_from, valid_to) VALUES
  (1,  'LCK',   1, '2010-01-01', NULL),
  (2,  'LPL',   2, '2010-01-01', NULL),
  (3,  'LEC',   3, '2010-01-01', NULL),
  (4,  'LCS',   4, '2010-01-01', NULL),
  (5,  'CBLOL', 5, '2010-01-01', NULL),
  (6,  'LCP',   6, '2010-01-01', NULL),
  (9,  'LTA N', 4, '2025-01-01', '2025-12-31'),
  (10, 'LTA S', 5, '2025-01-01', '2025-12-31'),
  (11, 'LTAN',  4, '2025-01-01', '2025-12-31'),
  (12, 'LTAS',  5, '2025-01-01', '2025-12-31');

-- Explicit ids above leave the sequences at 1, so the next ingest-driven insert
-- collides on the primary key.
SELECT setval('leagues_id_seq',        (SELECT max(id) FROM leagues));
SELECT setval('league_aliases_id_seq', (SELECT max(id) FROM league_aliases));
