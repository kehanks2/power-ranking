-- Drop an academy squad that Liquipedia lists on its parent team's page.
--
-- Team_Vitality returns ten players: the real five plus the five Rising Bees,
-- who then sat on the LEC board at a neutral 50 with no games -- five of the
-- twelve zero-game rows across all six boards, and every dot the board shows.
--
-- Same rule as withoutAcademyCohorts in populateRosterFromLiquipedia: a cohort
-- of ACADEMY_COHORT_MIN (3) or more players on ONE tracked team all naming the
-- same secondary squad that we do not track as a team. Never secondary_team
-- alone -- Ruler's is "Ohio State University" and he has 240 games.
--
-- This repairs today's rows. The importer is the real fix, but it replaces
-- roster_memberships wholesale and only runs against the Liquipedia API, so
-- without this the board keeps the Bees until the next roster import.
--
-- Keep the two in step: change the threshold here and in ACADEMY_COHORT_MIN.

BEGIN;

DELETE FROM roster_memberships rm
WHERE rm.secondary_team IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM teams t WHERE lower(t.name) = lower(rm.secondary_team)
  )
  AND (
    SELECT count(*) FROM roster_memberships peer
    WHERE peer.team_id = rm.team_id
      AND lower(peer.secondary_team) = lower(rm.secondary_team)
  ) >= 3;

COMMIT;
