import { startPgliteServer } from './pgliteTestServer.mjs';
import { usingPglite } from './testDatabaseUrl.mjs';

let server;

export async function setup() {
  if (!usingPglite()) return;
  server = await startPgliteServer();
}

export async function teardown() {
  await server?.stop();
}
