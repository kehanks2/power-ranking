-- Team crests, stored rather than linked.
--
-- Liquipedia refuses hotlinks by Referer: a request carrying no Referer answers
-- 200, one carrying our origin answers 403, so an <img> pointed at logo_url is
-- a broken image on every row. logo_url stays as the source pointer -- it is
-- what we re-fetch from, and what says which artwork this is -- and the bytes
-- live here so the API can serve them from our own origin.
--
-- Bytes rather than a path: hosting is still undecided (#29) and the API is the
-- one piece certain to be deployed. 58 active teams at ~6 KB each is ~350 KB.

ALTER TABLE teams
  ADD COLUMN logo_data         BYTEA,
  ADD COLUMN logo_content_type TEXT,
  -- Which logo_url the stored bytes came from. Comparing against the current
  -- logo_url is what makes a re-fetch happen exactly on a rebrand, rather than
  -- every roster import re-downloading 58 unchanged files.
  ADD COLUMN logo_source_url   TEXT,
  ADD COLUMN logo_fetched_at   TIMESTAMPTZ;
