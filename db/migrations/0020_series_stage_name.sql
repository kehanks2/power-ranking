-- Liquipedia's human-readable stage name for a series: "Playoffs", "Play-In",
-- "Week 9", "Group Stage".
--
-- `bracket_id` was the wrong thing to label a series by. It is a 10-character
-- id whose spelling is per-league and genuinely inconsistent, so a pattern rule
-- failed in both directions: LCS 2026 Lock-In's group stages were painted as
-- playoffs because they matched no regular-season pattern, and LCK's Road to
-- MSI -- which IS the spring playoff -- was missed because it is spelled
-- `LCKRtMSI26`. Around twenty more brackets were wrong the same way, and some
-- ids are opaque (`tl2OVsUfyX` is LPL 2024 Spring's playoff), so no pattern
-- could ever have caught them.
--
-- `section` says "Playoffs" for all of them. It stays the display label's
-- source; `bracket_id` keeps its own job, which is board advancement.

BEGIN;

ALTER TABLE series ADD COLUMN stage_name TEXT;

COMMIT;
