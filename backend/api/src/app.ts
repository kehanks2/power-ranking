import express, { type Express } from 'express';
import cors from 'cors';
import type { Pool } from 'pg';
import { isRatingWindow, INTERNATIONAL_EVENTS, type ChampionScope } from '@power-ranking/shared';
import {
  getLeagues,
  getTeams,
  getTeamById,
  getPlayers,
  getPlayerById,
  getBoardsLastUpdated,
  getTeamLogo,
  getChampionBoard,
  getChampionIndex,
} from './repositories.js';

/**
 * Cached hard, but only for a request that names which artwork it wants. The
 * boards link `?v=<digest of the source url>`, so new artwork is a new URL and
 * `immutable` is safe; without the token a cached crest would outlive its own
 * replacement for the whole max-age, which is how a re-fetch to the textless
 * marks left every existing visitor still looking at the old lockups.
 */
const LOGO_CACHE_IMMUTABLE = 'public, max-age=604800, immutable';
const LOGO_CACHE_UNVERSIONED = 'public, max-age=300, stale-while-revalidate=86400';

/** Thin, precomputed-only read API -- no request-time rating computation, per plan. */
export function createApp(pool: Pool): Express {
  const app = express();
  app.use(cors());

  app.get('/leagues', async (_req, res) => {
    const leagues = await getLeagues(pool);
    res.json(leagues);
  });

  app.get('/boards/updated', async (_req, res) => {
    res.json(await getBoardsLastUpdated(pool));
  });

  // No global team board: every board is one pool of evidence (one region, or
  // cross-region only), so `scope` is required rather than defaulting.
  app.get('/teams', async (req, res) => {
    const scope = typeof req.query.scope === 'string' ? req.query.scope : undefined;
    if (!scope) {
      res.status(400).json({ error: 'scope is required: "international" or a league slug' });
      return;
    }
    const teams = await getTeams(pool, scope);
    res.json(teams);
  });

  app.get('/teams/:id', async (req, res) => {
    const teamId = Number(req.params.id);
    if (!Number.isInteger(teamId)) {
      res.status(400).json({ error: 'invalid team id' });
      return;
    }
    const team = await getTeamById(pool, teamId);
    if (!team) {
      res.status(404).json({ error: 'team not found' });
      return;
    }
    res.json(team);
  });

  // Both spellings: the DTO names the crest with the extension its bytes need,
  // since the export serves it as a file, but the bare path is what this server
  // answered before and costs nothing to keep.
  app.get(['/teams/:id/logo', '/teams/:id/logo.:ext'], async (req, res) => {
    const teamId = Number(req.params.id);
    if (!Number.isInteger(teamId)) {
      res.status(400).json({ error: 'invalid team id' });
      return;
    }
    const logo = await getTeamLogo(pool, teamId);
    // 404 rather than a placeholder image: the board draws initials for a team
    // with no crest, and it needs the failure to say so.
    if (!logo) {
      res.status(404).json({ error: 'no logo for this team' });
      return;
    }
    res.setHeader('Cache-Control', req.query.v ? LOGO_CACHE_IMMUTABLE : LOGO_CACHE_UNVERSIONED);
    res.type(logo.contentType).send(logo.data);
  });

  app.get('/players', async (req, res) => {
    const league = typeof req.query.league === 'string' ? req.query.league : undefined;
    // Anything but explicit 'international' is regional -- an unrecognised scope
    // must not pass through and return a differently-scaled rating.
    const scope = req.query.scope === 'international' ? 'international' : 'regional';
    // Unrecognised window falls back to the full record, not an empty board.
    const window = isRatingWindow(req.query.window) ? req.query.window : 'all';
    const players = await getPlayers(pool, league, scope, window);
    res.json(players);
  });

  app.get('/players/:id', async (req, res) => {
    const playerId = Number(req.params.id);
    if (!Number.isInteger(playerId)) {
      res.status(400).json({ error: 'invalid player id' });
      return;
    }
    // Same narrowing as /players.
    const scope = req.query.scope === 'international' ? 'international' : 'regional';
    const window = isRatingWindow(req.query.window) ? req.query.window : 'all';
    const player = await getPlayerById(pool, playerId, scope, window);
    if (!player) {
      res.status(404).json({ error: 'player not found' });
      return;
    }
    res.json(player);
  });

  app.get('/champions', async (req, res) => {
    res.json(await getChampionIndex(pool));
  });

  app.get('/champions/:year/:scope', async (req, res) => {
    const year = Number(req.params.year);
    if (!Number.isInteger(year)) {
      res.status(400).json({ error: 'invalid year' });
      return;
    }
    const scope = championScopeFromKey(req.params.scope);
    if (!scope) {
      res.status(404).json({ error: 'unknown scope' });
      return;
    }
    // Only a regional scope has a split to narrow to; anything else ignores it,
    // rather than returning an empty board for a window it cannot honour.
    const requested = req.query.window === 'split' ? 'split' : 'year';
    const window = scope.kind === 'all' || scope.kind === 'league' ? requested : 'year';
    res.json(await getChampionBoard(pool, year, scope, window));
  });

  return app;
}

/**
 * The inverse of `championScopeKey`. A league slug is anything left over, and
 * the board comes back empty for one that does not exist -- there is no list of
 * slugs here to check against without a round trip.
 */
function championScopeFromKey(key: string): ChampionScope | null {
  if (key === 'all') return { kind: 'all' };
  if (key === 'international') return { kind: 'international' };
  const event = INTERNATIONAL_EVENTS.find((e) => e.key === key);
  if (event) return { kind: 'event', event: event.key };
  return /^[A-Za-z0-9_-]+$/.test(key) ? { kind: 'league', slug: key } : null;
}
