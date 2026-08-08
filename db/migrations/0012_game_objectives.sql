-- Neutral epic-monster objectives (dragons, barons, heralds, grubs, atakhans)
-- each team secured in a game. Feeds the jungle objective-control stat: the
-- jungler's share is their team's neutrals / both teams' neutrals that game, so
-- it is patch-agnostic (a type that did not exist that patch is simply 0).
-- Structures (towers, inhibitors) are deliberately excluded -- not jungle objectives.
ALTER TABLE games
  ADD COLUMN team1_neutral_objectives INTEGER,
  ADD COLUMN team2_neutral_objectives INTEGER;
