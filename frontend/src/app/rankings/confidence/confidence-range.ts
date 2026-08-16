/** Everything the range needs; both a board row and a roster row supply it. */
export interface RatingConfidence {
  rating: number;
  rawRating: number;
  confidence: number;
}

/** The axis divisions the header labels and every row draws a gridline at. */
export const AXIS_TICKS = [0, 25, 50, 75, 100];

const NEUTRAL_RATING = 50;

// Bucket cuts on the earned share `confidence`. The recency half-life caps it
// well below 1 -- the fullest board tops out near 0.90 -- so these are cut on
// that observed spread, not on a game count.
const SETTLED = 0.75;
const FIRMING = 0.4;

// In axis units, so roughly a pixel on the rendered track. A dashed box below
// this is a speck rather than a line, and a player sitting on their raw score
// has nothing left to project anyway.
const MIN_DRAWABLE_TAIL = 0.4;

/** The range as drawn, every figure already in 0-100 axis space. */
export interface ConfidenceRange {
  /** Solid: the 50 midline to the rating -- the distance the games have earned. */
  bandLeft: number;
  bandWidth: number;
  /** True when the rating sits below 50, so the band darkens toward it either way. */
  bandBelow: boolean;
  /** Dashed: the rating to the raw score. */
  tailLeft: number;
  tailWidth: number;
  showTail: boolean;
  /** True when the raw score is the lower of the two, so the dash joins on the right. */
  tailLeftward: boolean;
  point: number;
  /** The hover word, one of Settled / Firming / Provisional. */
  label: string;
  /** The whole bar in words, for screen readers. */
  description: string;
}

export function confidenceRange(value: RatingConfidence): ConfidenceRange {
  const clamp = (v: number) => Math.min(100, Math.max(0, v));
  const rating = clamp(value.rating);
  const raw = clamp(value.rawRating);
  const tailWidth = Math.abs(raw - rating);
  const label = value.confidence >= SETTLED ? 'Settled' : value.confidence >= FIRMING ? 'Firming' : 'Provisional';

  return {
    bandLeft: Math.min(NEUTRAL_RATING, rating),
    bandWidth: Math.abs(rating - NEUTRAL_RATING),
    bandBelow: rating < NEUTRAL_RATING,
    tailLeft: Math.min(rating, raw),
    tailWidth,
    showTail: tailWidth >= MIN_DRAWABLE_TAIL,
    tailLeftward: raw < rating,
    point: rating,
    label,
    description: `${label}: rated ${rating.toFixed(1)}, settling near ${raw.toFixed(0)} if this form holds.`,
  };
}
