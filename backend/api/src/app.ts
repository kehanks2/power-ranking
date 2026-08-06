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

  // There is no global team board. Every board is one pool of evidence: a
  // single region's games, or cross-region games only. Ranking teams that have
  // never played each other is exactly the guess this design removes, so
  // `scope` is required rather than defaulting to "everything".
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
