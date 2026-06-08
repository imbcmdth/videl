/**
 * OffsetTimeRanges — a read-only TimeRanges wrapper that shifts every
 * start/end value by a fixed constant offset.
 *
 * Used to convert MSE SourceBuffer.buffered (in video.currentTime space) to
 * wall-clock epoch space by adding wallAnchor, so that the entire pump tree
 * works in a single coordinate system without per-callsite conversions.
 *
 * Invariant:
 *   OffsetTimeRanges(inner, offset).start(i) === inner.start(i) + offset
 *   OffsetTimeRanges(inner, offset).end(i)   === inner.end(i)   + offset
 */
export class OffsetTimeRanges implements TimeRanges {
  readonly #inner:  TimeRanges;
  readonly #offset: number;

  constructor(inner: TimeRanges, offset: number) {
    this.#inner  = inner;
    this.#offset = offset;
  }

  get length(): number {
    return this.#inner.length;
  }

  start(i: number): number {
    return this.#inner.start(i) + this.#offset;
  }

  end(i: number): number {
    return this.#inner.end(i) + this.#offset;
  }
}
