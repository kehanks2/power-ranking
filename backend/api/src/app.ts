import express, { type Express } from 'express';
import cors from 'cors';
import type { Pool } from 'pg';
import { getLeagues, getTeams, getTeamById, getPlayers } from './repositories.js';

/** Thin, precomputed-only read API -- no request-time rating computation, per plan. */
export function createApp(pool: Pool): Express {
  const app = express();
  app.use(cors());

  app.get('/leagues', async (_req, res) => {
    const leagues = await getLeagues(pool);
    res.json(leagues);
  });

  app.get('/teams', async (req, res) => {
    const league = typeof req.query.league === 'string' ? req.query.league : undefined;
    const teams = await getTeams(pool, league);
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

  app.get('/players', async (req, res) => {
    const league = typeof req.query.league === 'string' ? req.query.league : undefined;
    // Anything other than an explicit 'international' is the regional view --
    // an unrecognised scope must not silently return a differently-scaled
    // rating, so this never passes the raw query value through.
    const scope = req.query.scope === 'international' ? 'international' : 'regional';
    const players = await getPlayers(pool, league, scope);
    res.json(players);
  });

  return app;
}
