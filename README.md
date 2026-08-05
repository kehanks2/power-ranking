# PowerRanking

A better LoL esports power ranking: individual team ratings, a league-vs-league
meta ranking, and a per-player rating, with a filterable Angular frontend.
Full design rationale lives in the plan doc: `MODEL.md`.

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
- `npm test --workspace=@power-ranking/ingestion` / `@power-ranking/api` -- integration tests against the live local Postgres (steps 1-2 above).

## Status

Schema, rating engine (Glicko-2 + margin-of-victory + roster/seasonal decay +
contextual/meta cross-region rating + player scoring), ingestion client, and
read API are built and tested. **No live Leaguepedia ingestion has been run
yet** -- the ingestion client (Cargo query builder, league-alias resolution,
idempotent upserts) is implemented and tested against synthetic data, but
wiring up a scheduled pull of real match data is the next step. The frontend
currently reflects that: 6 leagues seeded, 0 teams/players until ingestion runs.
