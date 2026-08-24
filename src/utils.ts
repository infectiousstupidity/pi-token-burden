import type { BarSegment, FilterItem } from './types.js';

/** Return whether an opaque value is a non-null, non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Return an array item or fail when the caller's index invariant is broken. */
export function getRequiredItem<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error('Expected an item at the requested index');
  }
  return item;
}

/**
 * Score a query against text using fuzzy matching.
 * Returns 0 for no match, higher scores for better matches.
 */
function fuzzyScore(query: string, text: string): number {
  const lowerQuery = query.toLowerCase();
  const lowerText = text.toLowerCase();

  // Exact substring match scores highest
  if (lowerText.includes(lowerQuery)) {
    return 100 + (lowerQuery.length / lowerText.length) * 50;
  }

  // Fuzzy character-by-character match
  let score = 0;
  let queryIndex = 0;
  let consecutiveBonus = 0;

  for (let i = 0; i < lowerText.length && queryIndex < lowerQuery.length; i++) {
    if (lowerText.charAt(i) === lowerQuery.charAt(queryIndex)) {
      score += 10 + consecutiveBonus;
      consecutiveBonus += 5;
      queryIndex++;
    } else {
      consecutiveBonus = 0;
    }
  }

  return queryIndex === lowerQuery.length ? score : 0;
}

/**
 * Filter and sort items by fuzzy match against their label.
 * Returns all items (unmodified order) when query is empty.
 */
export function fuzzyFilter<T extends FilterItem>(items: T[], query: string): T[] {
  if (!query.trim()) {
    return items;
  }

  const scored = items
    .map((item) => ({ item, score: fuzzyScore(query, item.label) }))
    .filter((entry) => entry.score > 0)
    .toSorted((a, b) => b.score - a.score);

  return scored.map((entry) => entry.item);
}

/**
 * Compute bar segment widths proportional to token counts.
 * Each segment gets at least 1 character. Excess is stolen from the largest.
 */
export function buildBarSegments(
  sections: { label: string; tokens: number }[],
  barWidth: number,
): BarSegment[] {
  if (sections.length === 0) {
    return [];
  }

  const positiveTotal = sections.reduce((sum, section) => sum + Math.max(0, section.tokens), 0);

  // If all tokens are zero, distribute evenly
  if (positiveTotal === 0 && sections.every((section) => section.tokens === 0)) {
    const baseWidth = Math.floor(barWidth / sections.length);
    let remainder = barWidth - baseWidth * sections.length;
    return sections.map((s) => {
      const extra = remainder > 0 ? 1 : 0;
      remainder--;
      return { label: s.label, width: baseWidth + extra };
    });
  }

  // Compute proportional widths. Signed reconciliation rows remain visible in
  // the legend/table but do not claim positive width in the stacked bar.
  const raw = sections.map((section) =>
    section.tokens > 0 ? (section.tokens / positiveTotal) * barWidth : 0,
  );

  // Floor each positive segment, enforcing minimum 1 only for counted burden.
  const widths = raw.map((width) => (width > 0 ? Math.max(1, Math.floor(width)) : 0));

  // Adjust total to match barWidth
  const currentTotal = widths.reduce((sum, w) => sum + w, 0);
  const diff = barWidth - currentTotal;

  if (diff > 0) {
    // Distribute extra to segments with largest fractional parts
    const fractionals = raw.map((w, i) => ({
      index: i,
      frac: w - getRequiredItem(widths, i),
    }));
    fractionals.sort((a, b) => b.frac - a.frac);
    for (let i = 0; i < diff; i++) {
      const { index } = getRequiredItem(fractionals, i % fractionals.length);
      widths[index] = getRequiredItem(widths, index) + 1;
    }
  } else if (diff < 0) {
    // Steal from largest segments
    for (let i = 0; i < -diff; i++) {
      let maxIdx = 0;
      for (let j = 1; j < widths.length; j++) {
        if (getRequiredItem(widths, j) > getRequiredItem(widths, maxIdx)) {
          maxIdx = j;
        }
      }
      const maxWidth = getRequiredItem(widths, maxIdx);
      if (maxWidth > 1) {
        widths[maxIdx] = maxWidth - 1;
      }
    }
  }

  return sections.map((s, i) => ({
    label: s.label,
    width: getRequiredItem(widths, i),
  }));
}
