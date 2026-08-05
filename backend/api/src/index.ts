import { createApp } from './app.js';
import { createPool } from './db.js';

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
const pool = createPool();
const app = createApp(pool);

app.listen(port, () => {
  console.log(`power-ranking API listening on port ${port}`);
});
