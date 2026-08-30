import type { Pool } from 'pg';
import sharp from 'sharp';

/**
 * Downloads team crests to our own database.
 *
 * Liquipedia refuses hotlinks by Referer -- no Referer answers 200, our origin
 * answers 403 -- so the artwork cannot be served from their URL and has to be
 * fetched once and served from ours. These are image files on the wiki's CDN,
 * not API calls, so they cost nothing against REQUESTS_PER_HOUR.
 *
 * Only teams whose logo_url differs from the logo_source_url already stored are
 * fetched, so a re-run after a rebrand downloads one file and a re-run after
 * nothing downloads none.
 */

const USER_AGENT = 'PowerRanking/1.0 (https://github.com/kehanks2/power-ranking)';

/** Well past any real crest; a wiki file this large is a mistake, not a logo. */
const MAX_BYTES = 2 * 1024 * 1024;

const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']);

/** Politeness between downloads, so 58 files are not a burst on someone else's CDN. */
const DELAY_MS = 150;

/**
 * Longest edge of what we store. The board draws a 26px crest, and Liquipedia
 * hands back 400px wordmarks -- 22 of those is 553 KB, more than the whole JS
 * bundle, for artwork shown at a 15th of its size. 72px covers the 26px slot to
 * beyond 2x and takes that to ~35 KB.
 */
const STORED_EDGE_PX = 72;

/**
 * Downscale to something the size of the slot it is drawn in.
 *
 * WebP, because these are flat wordmarks with hard edges and large transparent
 * areas, where it beats PNG substantially and is supported everywhere the app
 * runs. `fit: inside` keeps the aspect ratio -- a wordmark is not square, and
 * the crest is `object-fit: contain`.
 */
async function shrink(bytes: Buffer, contentType: string): Promise<{ data: Buffer; contentType: string }> {
  // SVG is already resolution-independent and tiny; rasterising it would make
  // it bigger and worse.
  if (contentType === 'image/svg+xml') return { data: bytes, contentType };

  const resized = await sharp(bytes)
    .resize({ width: STORED_EDGE_PX, height: STORED_EDGE_PX, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 90 })
    .toBuffer();
  // Never trade up: a crest already smaller than what we would produce keeps
  // its original bytes.
  return resized.byteLength < bytes.byteLength ? { data: resized, contentType: 'image/webp' } : { data: bytes, contentType };
}

export interface LogoFetchResult {
  fetched: number;
  unchanged: number;
  failed: { team: string; reason: string }[];
}

interface StaleRow {
  id: number;
  name: string;
  logo_url: string;
}

export async function fetchTeamLogos(pool: Pool): Promise<LogoFetchResult> {
  const stale = await pool.query<StaleRow>(
    `SELECT id, name, logo_url FROM teams
      WHERE logo_url IS NOT NULL
        AND (logo_data IS NULL OR logo_source_url IS DISTINCT FROM logo_url)
      ORDER BY id`,
  );

  const current = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM teams
      WHERE logo_url IS NOT NULL AND logo_data IS NOT NULL AND logo_source_url IS NOT DISTINCT FROM logo_url`,
  );

  const failed: LogoFetchResult['failed'] = [];
  let fetched = 0;

  for (const row of stale.rows) {
    try {
      // No Referer header: that is what their hotlink rule looks at, and a
      // server-side fetch legitimately has none.
      const res = await fetch(row.logo_url, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!ALLOWED_TYPES.has(contentType)) throw new Error(`unexpected content-type ${contentType || '(none)'}`);

      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.byteLength === 0) throw new Error('empty body');
      if (bytes.byteLength > MAX_BYTES) throw new Error(`${bytes.byteLength} bytes exceeds the cap`);

      const stored = await shrink(bytes, contentType);

      await pool.query(
        `UPDATE teams
            SET logo_data = $2, logo_content_type = $3, logo_source_url = $4, logo_fetched_at = now()
          WHERE id = $1`,
        [row.id, stored.data, stored.contentType, row.logo_url],
      );
      fetched += 1;
    } catch (err) {
      // A crest that will not download is cosmetic: the board falls back to
      // initials. Never let it cost the roster import its transaction.
      failed.push({ team: row.name, reason: err instanceof Error ? err.message : String(err) });
    }
    if (DELAY_MS > 0) await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  }

  // Counted before the fetch, or every crest this run downloaded would also
  // read as unchanged.
  return { fetched, unchanged: Number(current.rows[0]?.n ?? 0), failed };
}
