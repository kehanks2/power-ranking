import pg from 'pg';

const { Pool } = pg;

export function createPool(connectionString = process.env.DATABASE_URL): pg.Pool {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  // Capped: the free hosting tier allows 20 connections total, and vitest runs
  // several files at once, each building its own pool. pg's default of 10 per
  // pool exhausts the server before the suite finishes.
  return new Pool({ connectionString, max: 4 });
}
