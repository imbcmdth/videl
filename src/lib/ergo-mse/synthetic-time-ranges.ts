/**
 * SyntheticTimeRanges — a mutable TimeRanges-like object used by
 * TextSourceBuffer to track which time ranges have been populated with cues.
 *
 * Satisfies the same duck-type as the browser's read-only TimeRanges:
 *   .length, .start(i), .end(i)
 *
 * Internal representation: a sorted, non-overlapping array of [start, end]
 * pairs in ascending order. All units are seconds.
 */
export class SyntheticTimeRanges {
  #ranges: [number, number][] = [];

  get length(): number {
    return this.#ranges.length;
  }

  start(i: number): number {
    if (i < 0 || i >= this.#ranges.length) {
      throw new DOMException('Index out of range', 'IndexSizeError');
    }
    return this.#ranges[i][0];
  }

  end(i: number): number {
    if (i < 0 || i >= this.#ranges.length) {
      throw new DOMException('Index out of range', 'IndexSizeError');
    }
    return this.#ranges[i][1];
  }

  /**
   * Add [start, end] to the tracked ranges, merging any overlapping or
   * touching existing ranges.
   */
  add(start: number, end: number): void {
    if (start >= end) return;

    const result: [number, number][] = [];
    let mergedStart = start;
    let mergedEnd   = end;
    let placed      = false;

    for (const [rs, re] of this.#ranges) {
      if (re < mergedStart) {
        // Entirely before — keep as-is.
        result.push([rs, re]);
      } else if (rs > mergedEnd) {
        // Entirely after — emit the merged range first (once), then keep this.
        if (!placed) {
          result.push([mergedStart, mergedEnd]);
          placed = true;
        }
        result.push([rs, re]);
      } else {
        // Overlapping or touching — absorb into the merge window.
        mergedStart = Math.min(mergedStart, rs);
        mergedEnd   = Math.max(mergedEnd,   re);
      }
    }

    if (!placed) result.push([mergedStart, mergedEnd]);

    this.#ranges = result;
  }

  /**
   * Remove the portion [start, end) from all tracked ranges. Ranges that
   * straddle a boundary are split; ranges fully inside are removed entirely.
   */
  cut(start: number, end: number): void {
    if (start >= end) return;

    const result: [number, number][] = [];
    for (const [rs, re] of this.#ranges) {
      if (re <= start || rs >= end) {
        // No overlap — keep.
        result.push([rs, re]);
      } else {
        // Partial or full overlap.
        if (rs < start) result.push([rs, start]);
        if (re > end)   result.push([end, re]);
        // (fully inside → both conditions false → nothing pushed → range removed)
      }
    }

    this.#ranges = result;
  }

  /** Remove all tracked ranges. */
  clear(): void {
    this.#ranges = [];
  }
}
