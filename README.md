# PowerRanking

A better LoL esports power ranking: individual team ratings, a league-vs-league
meta ranking, and a per-player rating, with a filterable Angular frontend.
`MODEL.md` explains why the model is the way it is, including the alternatives
that were measured and rejected.

## Repo layout

```
/frontend               Angular app
/backend/api            Thin read API (Express)
/backend/ingestion      Leaguepedia Cargo client + idempotent upserts
/backend/rating-engine  Glicko-2 core, decay, contextual+meta, player rating (pure, unit-tested)
/backend/shared         Shared DTO types
/db/migrations          SQL schema
/db/seed                League + league_aliases seed data
```

## Local development

1. Start Postgres (mapped to host port **5433**, not 5432 -- see `docker-compose.yml` comment for why):
   ```
   docker compose up -d
   ```
2. Apply schema + seed data (first time only, or after wiping the volume):
   ```
   docker exec -i power-ranking-db psql -U powerranking -d powerranking < db/migrations/0001_init.sql
   docker exec -i power-ranking-db psql -U powerranking -d powerranking < db/seed/001_leagues_and_aliases.sql
   ```
3. Install dependencies from the repo root (npm workspaces link the backend packages):
   ```
   npm install
   ```
4. Build the packages the API depends on:
   ```
   npm run build --workspace=@power-ranking/shared
   npm run build --workspace=@power-ranking/rating-engine
   ```
5. Run the API (reads `DATABASE_URL` from `.env`):
   ```
   npm run dev --workspace=@power-ranking/api
   ```
6. Run the frontend:
   ```
   cd frontend && npx ng serve
   ```
   Visit http://localhost:4200.

## Tests

- `npm test --workspace=@power-ranking/rating-engine` -- pure unit tests, no DB needed.
- `npm test --workspace=@power-ranking/ingestion` / `@power-ranking/api` -- integration
  tests against a live Postgres. These run against **`powerranking_test`**, forced in
  each `vitest.config.ts` and ignoring any `DATABASE_URL` you have set, because the
  ingestion suite wipes and rebuilds the rating tables. Seed the clone with:
  ```
  docker exec power-ranking-db psql -U powerranking -d postgres -c "CREATE DATABASE powerranking_test TEMPLATE powerranking"
  ```
  They assert against real ingested data, so an empty database will fail them.

## Data and attribution

Match, tournament, and player data is from **[Liquipedia](https://liquipedia.net)**,
retrieved through the [Liquipedia API](https://liquipedia.net/api-terms-of-use)
for the [League of Legends wiki](https://liquipedia.net/leagueoflegends).

Liquipedia text content is licensed under
**[CC-BY-SA 3.0 US](https://creativecommons.org/licenses/by-sa/3.0/us/)**.

**Changes were made.** Nothing here reproduces Liquipedia articles. Match
results, rosters, and per-game statistics are parsed into a relational schema and
transformed into ratings by this project's own model (`MODEL.md`); the ratings,
rankings, and confidence figures are computed here and are not Liquipedia
content. The data derived from Liquipedia is shared under the same
**CC-BY-SA 3.0 US** licence, as share-alike requires.

Liquipedia is not affiliated with this project and does not endorse it.

This project also follows the
[API Terms of Use](https://liquipedia.net/api-terms-of-use):

- Requests carry a descriptive `User-Agent` identifying the project with a link back.
- Requests are capped well under the documented limit (40/hour against a 60/hour cap),
  and consecutive pages of one pull are paced apart.
- Results are stored and re-used; pulls are bounded to the dates not already held, so
  the same data is not requested twice.
- Only the API is used. No automated access to Liquipedia's HTML pages.

## Status

Schema, rating engine (Glicko-2 + margin-of-victory + roster/seasonal decay +
contextual/meta cross-region rating + player scoring), ingestion, and the read
API are built and tested, running against real ingested data across the six
major leagues. Ratings are recomputed by a full replay, so the pipeline is safe
to re-run at any time.

Not yet done: the daily update (`backend/ingestion/src/dailyUpdate.ts`) is
written but not scheduled, and the database is still local.
