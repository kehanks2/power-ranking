# The rating model

Every number here is either a published Glicko-2 default, a direct consequence
of the data, or the winner of a recorded sweep. Nothing is set by intuition. If
you change one, re-run the sweeps — several of these interact, and tuning them
one at a time is how `SERIES_CORRELATION` stayed stale for months after the bug
it was compensating for had been fixed.

## Structure

A team's displayed rating is

```
rating = contextual + effectiveMetaWeight(league) x participation(team) x leagueMeta
```

Two terms, each answering a question the other cannot:

- **contextual** — how good is this team, measured against everyone it has
  played. Updated by every game.
- **leagueMeta** — how strong is this region, measured only from international
  games. It is the *only* cross-region signal for a team that never leaves its
  league.

These are not redundant. Measured: mean contextual offsets by league span just
85 points and are not even correctly ordered (CBLOL, the weakest region, has the
highest mean), because contextual floats within each league's own pool. The meta
carries essentially all cross-region information.

Two structural alternatives were tested and rejected on data, not taste:

| Alternative | Result |
|---|---|
| Drop the meta entirely (`metaWeight = 0`) | per-league calibration collapses, 7.80pp vs 2.93pp |
| Shrink the meta as a team accrues its own international record | worse on every metric, monotonically (Brier 0.2350 at k=10 vs 0.2259 with no shrink) |

The second is the intuitive "the prior should yield to evidence" idea. It fails
because a team's contextual rating is still earned mostly in regional games no
matter how many internationals it plays, so the prior never becomes redundant.

### Regional boards are deliberately unbounded

The International board is cut to the last six events. Regional boards are not,
and that asymmetry is intentional rather than an oversight.

Tested by feeding the replay only the last N months and scoring every candidate
on the **same** 1,573 recent games (`checkModelQuality --window-months N
--eval-since`), so a shorter window cannot flatter itself by being graded on a
different, easier set:

| Input window | Accuracy | Brier |
|---|---|---|
| unbounded | 62.75% | 0.2253 |
| 24 months | 62.94% | 0.2250 |
| 18 months | 63.64% | 0.2249 |
| 12 months | 63.38% | 0.2256 |

18 months looks best on both, but the accuracy gap over unbounded is 14 games
of 1,573 against a standard error of about 19 — inside noise — and the Brier
gap is 0.0004. Cutting to 12 months is measurably worse, which is the useful
part of the result: past a point a window is just discarding evidence.

The mechanism explains why the two boards differ. International events run 2-3
a year, so a half-life alone lets a 2024 result leak in forever at ever-smaller
weight, and the board's whole claim is "who is good at this level *now*" — a
hard cutoff is what makes that true. Regional play is continuous at 40-80 games
a split, so Glicko's time-scaled drift plus sheer volume has already swamped old
results. No team currently on a regional board has less than 44% of its games
inside 18 months.

A *presentational* window ("this split only") is a separate product question and
would be easy; the model does not ask for one.

### Player transfers between leagues

A player arriving from another league is not an unknown quantity, so their
group rating is shrunk toward a carryover anchor rather than a flat 50 (see
`DEFAULT_TRANSFER_CARRYOVER`). Two things about the size and shape of that
anchor were settled on data:

| Question | Answer |
|---|---|
| How much of a percentile carries between leagues? | Slope **0.315**, r² = 0.099, over 100 observations of players with 15+ games in two leagues at the same role |
| Should the carryover be adjusted by league strength? | **No.** corr(league-rating gap, percentile change) = **−0.19** — weak, and pointing the wrong way |

The second is the intuitive one and it is worth being explicit about why it was
dropped. Moving to a stronger league "should" cost a player percentile, and a
league-strength term would have looked more principled than a flat carryover.
The data does not merely fail to support it, it leans the other way, so the
term would have added noise with a rigorous-looking justification. The flat
carryover stays until there is evidence for something better.

Note what the r² of 0.10 means in practice: past-league standing is real
evidence but weak, which is exactly why the anchor keeps only about a third of
the distance from neutral. Effect on the current dataset is 124 of 671 groups
moving, 1.13 points on average and 7.45 at most; team ratings are unchanged
(Brier 0.2247 either way) since the roster-implied prior reads the primary
group.

This does nothing for a player with no record anywhere — currently 28 of 352
rostered players, mostly academy call-ups and new teams. That gap needs tier-2
data, not a better prior.

### Player boards do carry a window; team boards still do not

The regional player board is computed over three windows — `all`, `year`,
`split` (`db/migrations/0011`) — and the international one over `all` only.

This does not contradict the section above. That result is about **prediction**:
throwing away a team's older games does not forecast their next game any better,
so the team boards stay unbounded. The player windows answer a different
question. All-Pro and MVP are awards for a stated stretch of play, and "who has
been best this split" is not a prediction at all — it is a description of a
period, and a career-shaped rating with a 120-day half-life is not one.

Both bounded windows key off each league's **own** current split start, not a
shared date: the leagues do not run on the same calendar, and one cutoff for all
six would hand one region three months of play and another three days.

Nothing about the method changes between windows — same components, same
weights, same shrinkage, fewer games. Shrinkage is what keeps the short windows
honest: a split is a few dozen games, so those ratings sit closer to the neutral
50 than the all-time board does, and the UI says so rather than letting a
narrower spread read as a bug.

| Window | Groups rated | Mean games behind a rating |
|---|---|---|
| all | 671 | 81.8 |
| year | 397 | 45.9 |
| split | 299 | 13.5 |

The ordering is genuinely different, which is the point — on LCK the all-time
board leads Peyz, Chovy, Ruler, while the current split leads Peyz, Chovy,
Aiming.

## Parameters

### Glicko-2 core — published defaults, not tuned

| Name | Value | Source |
|---|---|---|
| `DEFAULT_RATING` | 1500 | Glickman's Glicko-2 paper |
| `DEFAULT_RD` / `PHI_INIT_MAX` | 350 | Glickman |
| `DEFAULT_VOLATILITY` (sigma) | 0.06 | Glickman |
| `DEFAULT_TAU` | 0.5 | Glickman's suggested 0.3–1.2, low end for a domain with modest true week-to-week change |
| `SIGMA_REFERENCE_DAYS` | 7 | Glicko-2 defines volatility per rating period without fixing the period's length, so the reference has to be pinned somewhere; 7 days is what sigma was calibrated against |

### Jointly swept — `manualModelSweep.ts`, 48 configurations

Primary criterion is **Brier score**, a strictly proper scoring rule: unlike
accuracy it cannot be improved by shading probabilities toward 50%.

| Name | Value | Why |
|---|---|---|
| `META_WEIGHT` | 0.5 | Grid minimum on Brier (0.2254) and log loss (0.6434); overconfidence 5.3pp vs 6.7pp at 0.8; league spread 1.20x the Bradley-Terry fit vs 1.45x |
| `SERIES_CORRELATION` | 0.6 | Games inside a series are not independent; weight `1/(1+(n-1)*rho)`, so a 3-0 counts as 1.36 games. Best overconfidence in the grid (5.3pp vs 6.9pp at rho=0) |
| `INTERNATIONAL_WEIGHT_MULTIPLIER` | 2 | International games are the only cross-region evidence and only ~500 of 5,929, so at equal weight regional volume decides everything. Brier marginally prefers 1x, but the difference (0.2256 vs 0.2259) is inside noise while the ordering effect is not — BLG beat T1 and Hanwha Life head-to-head in 2026 and ranked below both at 1x |
| `RATING_PERIOD_DAYS` | 1 | A genuinely free knob since drift became time-scaled: total uncertainty growth over a span no longer depends on how finely it is sliced. Daily is correct during international events where a team plays several series in a week |

### Cross-region credit

| Name | Value | Why |
|---|---|---|
| `META_PARTICIPATION_FULL_CREDIT_DAYS` | 182 | A year of undiminished regional credit spans a whole competitive season. Six months means credit lapses if a team misses the next international cycle, matching the First Stand → MSI → Worlds cadence |
| `META_PARTICIPATION_ZERO_CREDIT_DAYS` | 730 | Two years without an international appearance is a different organisation |
| `META_PARTICIPATION_FLOOR` | 0.3 | Never zero: a team that has never had the chance still belongs to its region |
| `effectiveMetaWeight` | derived | Not a knob — shrinks league credit by the meta's own confidence (`1 - phi_meta/phi_init_max`), so an uncertain league rating counts for less automatically |

### Decay

| Name | Value | Why |
|---|---|---|
| `DEFAULT_PRIOR_CONFIDENCE_RELIEF` | 0.8 | A roster change should not reset RD to cold-start when we already know the incoming players well enough to move mu with them. Swept: Brier bottoms at 0.8 (0.2244 vs 0.2246 at 0.6, 0.2258 at 0) and median displayed RD falls to 82 from 92 and 109. Not 1.0 despite accuracy peaking there (64.35%) — Brier is worse at 1.0, and five known players are still an unknown combination, so a fifth of the widening survives |
| `DEFAULT_ROSTER_CHANGE_PERSISTENCE_GAMES` | 5 | Backtested: 289 roster events and 63.16% accuracy at 5, against 422 events and 62.39% at 2 — bench rotation was being counted as turnover |
| `ROSTER_CHANGE_MIN_GAMES` | 10 | Games before an incoming player's rating is trusted at full weight |
| `OFFSET_SCALE` | 150 | Rating points a maximally-rated incoming roster is worth against the league mean |
| `K_SEASON` | 0.25 | Split-boundary regression toward the league mean |

### Player composite — the win weight corrects a double-count

`DEFAULT_WIN_WEIGHT` is **0.4**, cut from 0.5 on 2026-08-16. This is not a
re-weighting of the model's priorities; it undoes an exposure increase nobody
chose.

0.5 was set when the box score was four uniform stats. v3 then added `goldDiff`
and re-weighted `kda`, and both are 0.79-0.92 correlated with a player's win
rate — `goldDiff` is end-of-game, so it is positive 83-92% of the time the team
won. Winning was being counted three times.

Measured as the correlation between a player's rating and their own team's win
rate (`teamCorr`, from `manualWeightConfigSweep.ts`), with walk-forward AUC over
six monthly cutoffs on 1,255 held-out games:

Re-measured 2026-08-18 on 59,166 player-game rows and 6,226 intra-league games.
Faker's rank is the face-validity anchor — the sweep reports several, and he is
the one whose true rank nobody disputes.

| config | teamCorr | held-out AUC | Faker |
|---|---|---|---|
| v2 uniform, win 0.5 — when 0.5 was chosen | 0.654 | 0.6797 | 173 |
| v3 per-role, win 0.5 — the double-count | 0.681 | 0.6796 | 116 |
| **v4 per-role, win 0.4 — shipped** | **0.652** | **0.6778** | **156** |
| win 0.3 | 0.613 | 0.6740 | 213 |
| no winRate | 0.430 | 0.6469 | 550 |
| no winRate/goldDiff | 0.336 | 0.6150 | 591 |
| no winRate/goldDiff/kda | 0.175 | 0.5482 | 601 |

0.4 lands at 0.652 against the original 0.654: the balance restored, not
changed. Note v3's extra stats bought no accuracy (0.6796 vs 0.6797) — they only
added team correlation.

**The bottom of the table is why `teamCorr = 0` is not the target.** Stripping
every win-correlated term reaches 0.175, and the board it produces ranks Faker
601st while its held-out AUC collapses to 0.5482 — a coin flip. Good players
genuinely win more, and good teams recruit good players, so some correlation is
irreducible; nobody knows its value. The parameter is bracketed by two failure
modes with no objective function between them, which is why it is settled by
judgement and left alone.

**Held-out accuracy cannot pick this parameter.** It rises monotonically to a win
weight of 1.0 — "rank every player by their team's record and discard the box
score" — because a prediction objective always prefers the purest team-strength
proxy. A paired bootstrap over 2,000 draws puts everything from 0.5 to 1.0
inside sampling noise. Optimising it would produce a standings table wearing a
player board's clothes, so the criterion here is `teamCorr`, not Brier.

**0.3 was tried first and rejected on a behavioural check.** A blend test dating
from the original decision asserts that a winning playmaker (KDA 20, KP 90,
win rate 95) outranks a losing stat-padder (KDA 95, win rate 15) — the case
where a support engages into four, reads as a death, and wins the game. That
holds at 0.4 and breaks at 0.3.

Two consequences worth knowing:

- **Gold diff @14 would fix the double-count at its source** by isolating the
  laning phase, rather than trimming the labelled term to compensate for the
  unlabelled ones. Liquipedia exposes only end-of-game totals, so it needs
  another provider.
- **Changing the win weight moves the team boards too**, because player ratings
  feed the roster-decay prior and the international seeds. Measured: 5 of 8 team
  boards reordered, almost all by one place, international most (5 of 24 teams)
  since it is seeded from player ratings.
- **`PLAYER_RATING_METHOD_VERSION` must be bumped with any weight change.**
  Rank-change carets refuse a baseline generation from a different
  `method_version`, and that guard is the only thing preventing a retune being
  reported as player movement — the 0.5 → 0.3 step "moved" 42 of 57 LCK players
  before it existed.

### DPM — measured, not shipped

Damage per minute is derivable with no re-ingest (`damage_to_champions` and
`games.gamelength_seconds`), and covers 99.93% of rows (59,146 of 59,186, mean
663). Its correlation with winning is **+0.055 to +0.096 by role** — near zero
beside `goldDiff`'s 0.79-0.92, which is what makes it interesting. (An earlier
note put it at -0.21 to -0.01; re-measured, the sign is positive and the
magnitude smaller.)

Swept 2026-08-18, taking DPM's share out of the box score and leaving `winRate`
untouched, so it tests DPM against the other stats rather than changing outcome
exposure at the same time:

| config | teamCorr | held-out AUC | Faker | Chovy | Knight |
|---|---|---|---|---|---|
| shipped | 0.652 | 0.6778 | 156 | 4 | 5 |
| dpm 0.10 | 0.615 | 0.6769 | 150 | 3 | 5 |
| dpm 0.20 | 0.542 | 0.6754 | 142 | 3 | 4 |
| dpm 0.20, win 0.30 | 0.487 | 0.6709 | 376 | 6 | 8 |
| dpm replaces goldDiff | 0.575 | 0.6713 | 266 | 12 | 13 |

**DPM decontaminates far more cheaply than cutting the win weight.** Reaching
teamCorr ~0.61 by win weight costs AUC 0.6740 and drops Faker to 213; DPM
reaches 0.615 at AUC 0.6769 with Faker at 150. At 0.20 it takes teamCorr to
0.542 — below anything the win weight can reach without collapsing — for 0.0024
of AUC, which the paired bootstrap above puts inside sampling noise.

The face-validity anchors *improve* rather than degrade (Faker 156 → 142, Chovy
4 → 3, Knight 5 → 4), which is the opposite of what happens when teamCorr is cut
by deleting win-correlated terms (Faker 550, 591, 601). That is the evidence DPM
is individual signal rather than noise: it is the only lever found so far that
lowers team correlation without making the board less recognisable.

Two negative results worth keeping: stacking DPM on a lower win weight
overshoots (Faker 376), and DPM is not a substitute for `goldDiff` (Faker 266,
Chovy 12) — it should come out of the box score as a whole.

Not shipped. Adopting it changes `PLAYER_RATING_METHOD_VERSION` and moves the
team boards through the roster-decay prior and international seeds, so it is a
decision rather than a sweep result.

### Margin of victory — deliberately disabled

`MARGIN_SCALE` is set to 1e9, which makes the MOV weight ~1 for every game.
Confirmed net-negative for accuracy across two independent backtests. The code
path is kept intact so it can be re-tested, but it is off.

## Where the model still errs

Measured, not guessed. Re-check with the runners below.

- **Overconfident.** In the >80% confidence band it predicts ~85.4% and delivers
  ~79.3%, a 6.1pp gap. This is the reason RD cannot simply be narrowed to make
  the board look tighter: narrower RD makes probabilities more extreme, which
  makes this worse.

  The 5.3pp previously recorded here was measured on the wrong model.
  `checkModelQuality.ts` hard-coded `metaWeight` 0.8 and `seriesCorrelation`
  0.8 under a comment claiming it was "kept in lockstep with computeRatings.ts"
  — which ships 0.5 and 0.6 — so the standing quality diagnostic described a
  hypothetical. The tuned constants now live in `rating-engine`'s
  `productionConfig.ts` and every consumer imports them, so that particular
  drift cannot recur. Measured properly, the shipped model is *better* than the
  drifted one reported on accuracy (63.97% vs 63.41% game, 68.55% vs 67.91%
  series) and slightly worse on this gap.
- **League spread is 1.20x the Bradley-Terry fit** of the same 435 cross-league
  games. It is honest where data is thick — the model's LCK–LPL gap predicts
  59.5% against an actual 59.2% over 103 games — and overstated at the CBLOL
  end, which has only 48 cross-league games.
- **LCS is under-rated**, winning 43.0% of cross-league games against a
  prediction near 37%.

  This was NOT the missing 2025 season. Backfilling it added 189 LCS and 146
  CBLOL games and moved the gap by 0.1pp, from +8.4pp to +8.5pp. The cause is
  the intransitive LCS/LEC matchup below, not thin data. Most of this is one genuinely intransitive matchup, not a
  scaling error.

  LEC is the better league against every large common opponent — 31.1% vs LCK
  where LCS manages 19.4%, 37.2% vs LPL where LCS manages 20.0%, 65.1% vs LCP
  where LCS manages 55.6%. But LCS beats LEC head-to-head 15-4, across five
  separate events and three different LCS organisations (Team Liquid, FlyQuest,
  LYON), including 6-0 at the 2026 MSI. It is a persistent matchup effect, not a
  small-sample fluke.

  A single number per league has to pick one of those stories. Ours sides with
  the common-opponent evidence, which has 137 LEC games and 102 LCS games behind
  it against only 19 head-to-head, and so rates LEC above LCS. Every Elo-family
  system has this limitation; representing it would require a matchup term
  rather than one rating per league.

  The team ratings soften it but do not undo it. LYON (LCS) carries the higher
  point estimate than G2 (LEC), 1675 to 1667, which the head-to-head supports —
  but G2 still ranks above LYON on the board, because ranking is by
  `conservativeRank` and G2 is the more certain of the two (RD 58 vs 66).

## Ranking order vs displayed rating

The board is ordered by `conservativeRank` (rating − `DEFAULT_CONSERVATIVE_K` ×
RD) but displays the raw rating. These are different quantities, so the table
can legitimately show a lower number above a higher one — currently 18 of 55
adjacent pairs, the largest inversion being 59 points (JD Gaming 1644 at #13
above Invictus Gaming 1704 at #14, which carries RD 129).

The ordering itself is defensible and standard: TrueSkill leaderboards rank on a
conservative estimate for the same reason, so that a team with a high but
poorly-evidenced rating does not sit above a well-established one. It is also
doing useful work here — it is what keeps high-RD teams like BNK FEARX and
Invictus Gaming out of the top few places.

What is not defensible is ranking by one number and displaying another, which
reads as a sorting bug. Either display the conservative value that is actually
sorted on, or sort on the displayed rating and let the ± column carry the
uncertainty. This is an open UI decision, not a model one.

## Diagnostics

All of them import the shipped constants from `rating-engine`'s
`productionConfig.ts` rather than restating them. They used to hand-copy the
values and drifted apart — five files, three different `metaWeight`s, one of
them under a comment claiming it was in lockstep.

| Runner | Question |
|---|---|
| `manualModelSweep.ts` | joint parameter grid, all metrics at once |
| `checkModelQuality.ts` | accuracy, Brier, and calibration of what ships. `--relief`, `--window-months`, and `--eval-since` sweep a knob through this same evaluation instead of a second copy of it |
| `manualBacktest.ts` | walk-forward accuracy |
| `manualSeriesCorrelationSweep.ts` | rho vs calibration and RD |
| `manualLeagueCalibration.ts` | is a region over- or under-rated |
| `manualLeagueSpreadCheck.ts` | Bradley-Terry fit of the league gaps |
| `manualIntlWeightSweep.ts` | cross-region evidence weight |
| `manualWinWeightSweep.ts` | player rating win weight |
