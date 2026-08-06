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
| `DEFAULT_PRIOR_CONFIDENCE_RELIEF` | 0.6 | A roster change should not reset RD to cold-start when we already know the incoming players well enough to move mu with them. 40% of the widening survives at full confidence because five known players are still an unknown combination |
| `DEFAULT_ROSTER_CHANGE_PERSISTENCE_GAMES` | 5 | Backtested: 289 roster events and 63.16% accuracy at 5, against 422 events and 62.39% at 2 — bench rotation was being counted as turnover |
| `ROSTER_CHANGE_MIN_GAMES` | 10 | Games before an incoming player's rating is trusted at full weight |
| `OFFSET_SCALE` | 150 | Rating points a maximally-rated incoming roster is worth against the league mean |
| `K_SEASON` | 0.25 | Split-boundary regression toward the league mean |

### Margin of victory — deliberately disabled

`MARGIN_SCALE` is set to 1e9, which makes the MOV weight ~1 for every game.
Confirmed net-negative for accuracy across two independent backtests. The code
path is kept intact so it can be re-tested, but it is off.

## Where the model still errs

Measured, not guessed. Re-check with the runners below.

- **Overconfident.** In the >80% confidence band it predicts ~85% and delivers
  ~79%, a 5.3pp gap. This is the reason RD cannot simply be narrowed to make the
  board look tighter: narrower RD makes probabilities more extreme, which makes
  this worse.
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

| Runner | Question |
|---|---|
| `manualModelSweep.ts` | joint parameter grid, all metrics at once |
| `manualBacktest.ts` | walk-forward accuracy |
| `manualSeriesCorrelationSweep.ts` | rho vs calibration and RD |
| `manualLeagueCalibration.ts` | is a region over- or under-rated |
| `manualLeagueSpreadCheck.ts` | Bradley-Terry fit of the league gaps |
| `manualIntlWeightSweep.ts` | cross-region evidence weight |
| `manualWinWeightSweep.ts` | player rating win weight |
