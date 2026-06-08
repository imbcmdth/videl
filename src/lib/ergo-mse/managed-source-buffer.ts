import type { ISourceBuffer } from './i-source-buffer';
import { OffsetTimeRanges } from './offset-time-ranges';

type MsbQueueEntry =
  | { kind: 'append';              data: ArrayBuffer | ArrayBufferView; resolve: () => void; reject: (e: Error) => void }
  | { kind: 'remove';              start: number; end: number;           resolve: () => void; reject: (e: Error) => void }
  | { kind: 'abort';                                                      resolve: () => void; reject: (e: Error) => void }
  | { kind: 'changeType';          mimeAndCodecs: string;                resolve: () => void; reject: (e: Error) => void }
  | { kind: 'timestampOffset';     value: number;                        resolve: () => void; reject: (e: Error) => void }
  | { kind: 'appendWindowStart';   value: number;                        resolve: () => void; reject: (e: Error) => void }
  | { kind: 'appendWindowEnd';     value: number;                        resolve: () => void; reject: (e: Error) => void }
  | { kind: 'mode';                value: 'segments' | 'sequence';       resolve: () => void; reject: (e: Error) => void };

/**
 * ManagedSourceBuffer is a promise-based wrapper around the browser's event-driven
 * SourceBuffer API. It serializes concurrent operations internally and surfaces
 * errors as rejected promises.
 *
 * Implements ISourceBuffer so it is interchangeable with TextSourceBuffer
 * throughout the element tree.
 *
 * ## Wall-clock coordinate system
 *
 * All time values accepted by this class (timestampOffset, appendWindowStart,
 * appendWindowEnd, remove start/end) are **wall-clock epoch seconds**. The
 * class translates them to player-time (video.currentTime space) by subtracting
 * `wallAnchor` before applying to the underlying SourceBuffer.
 *
 * `buffered` is translated in the opposite direction: the inner SourceBuffer's
 * currentTime-space ranges are shifted by +wallAnchor so callers always see
 * wall-clock epoch values.
 *
 * Set `wallAnchor` once (via videl-player) before any other calls.
 */
export class ManagedSourceBuffer implements ISourceBuffer {
  #sourceBuffer: SourceBuffer;
  #queue: Array<MsbQueueEntry> = [];
  #isProcessing = false;

  /**
   * Wall-clock epoch second corresponding to video.currentTime = 0.
   * Set by videl-player immediately after addSourceBuffer returns.
   */
  wallAnchor = 0;

  constructor(sourceBuffer: SourceBuffer) {
    this.#sourceBuffer = sourceBuffer;
  }

  // ── Operations ────────────────────────────────────────────────────────────

  /**
   * Append bytes. Queued if another operation is in progress.
   */
  async append(data: ArrayBuffer | ArrayBufferView): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#queue.push({ kind: 'append', data, resolve, reject });
      this.#processQueue();
    });
  }

  /**
   * Remove buffered range [start, end) in **wall-clock epoch seconds**.
   * Translates to player-time by subtracting wallAnchor before the real call.
   * Infinity end is preserved as-is.
   */
  async remove(start: number, end: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const a = start - this.wallAnchor;
      const b = end === Infinity ? Infinity : end - this.wallAnchor;
      this.#queue.push({ kind: 'remove', start: a, end: b, resolve, reject });
      this.#processQueue();
    });
  }

  /**
   * Abort the current operation; clears the pending queue; resolves when settled.
   */
  async abort(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const startIdx = this.#isProcessing ? 1 : 0;
      const drained  = this.#queue.splice(startIdx);
      for (const op of drained) {
        op.reject(new Error('Aborted'));
      }

      if (!this.#isProcessing) {
        resolve(); return;
      }

      this.#queue.push({ kind: 'abort', resolve, reject });
    });
  }

  /**
   * Change the MIME+codecs type of the underlying SourceBuffer.
   *
   * The application is queued so it cannot race with an in-flight append or
   * remove. Callers should not attempt to append data for the new type until
   * the queue has drained past this operation — in practice this is guaranteed
   * naturally because subsequent append() calls are themselves queued.
   *
   * Pre-validates the type synchronously via isTypeSupported() so that callers
   * using a try/catch to detect unsupported types still get a synchronous throw,
   * matching the browser's own error contract for this failure mode.
   */
  changeType(type: string): void {
    if (!MediaSource.isTypeSupported(type)) {
      throw new DOMException(`The type '${type}' is not supported.`, 'NotSupportedError');
    }
    this.#queue.push({ kind: 'changeType', mimeAndCodecs: type, resolve: () => {}, reject: () => {} });
    this.#processQueue();
  }

  // ── Properties ────────────────────────────────────────────────────────────

  get updating(): boolean {
    return this.#sourceBuffer.updating;
  }

  /**
   * Buffered time ranges in **wall-clock epoch seconds**.
   * Wraps the underlying currentTime-space SourceBuffer.buffered with
   * OffsetTimeRanges(+wallAnchor).
   */
  get buffered(): TimeRanges {
    return new OffsetTimeRanges(this.#sourceBuffer.buffered, this.wallAnchor);
  }

  /**
   * Offset (in wall-clock epoch seconds) added to media decode times.
   * Getter returns the raw SourceBuffer.timestampOffset (player-time space) —
   * callers that set and forget do not need to re-translate the getter.
   *
   * Setter accepts **wall-clock epoch seconds** and translates to player-time:
   *   actual = wallOffset − wallAnchor
   *
   * VOD (wallAnchor = 0): actual = wallOffset — identical to prior behaviour.
   * live-dvr: actual = availStart − (activationNow − TSBD)
   *         = availStart + TSBD − activationNow   (matches ADR-0005)
   */
  get timestampOffset(): number {
    return this.#sourceBuffer.timestampOffset;
  }
  set timestampOffset(wallOffset: number) {
    this.#queue.push({ kind: 'timestampOffset', value: wallOffset - this.wallAnchor, resolve: () => {}, reject: () => {} });
    this.#processQueue();
  }

  /**
   * Append window start in **wall-clock epoch seconds**.
   * Getter returns the raw SourceBuffer value (player-time).
   * Setter subtracts wallAnchor and queues the assignment.
   */
  get appendWindowStart(): number {
    return this.#sourceBuffer.appendWindowStart;
  }
  set appendWindowStart(wallValue: number) {
    this.#queue.push({ kind: 'appendWindowStart', value: wallValue - this.wallAnchor, resolve: () => {}, reject: () => {} });
    this.#processQueue();
  }

  /**
   * Append window end in **wall-clock epoch seconds**.
   * Getter returns the raw SourceBuffer value (player-time).
   * Setter subtracts wallAnchor and queues the assignment.
   */
  get appendWindowEnd(): number {
    return this.#sourceBuffer.appendWindowEnd;
  }
  set appendWindowEnd(wallValue: number) {
    this.#queue.push({ kind: 'appendWindowEnd', value: wallValue - this.wallAnchor, resolve: () => {}, reject: () => {} });
    this.#processQueue();
  }

  /**
   * SourceBuffer mode. Queued for ordering safety alongside changeType.
   */
  get mode(): 'segments' | 'sequence' {
    return this.#sourceBuffer.mode;
  }
  set mode(value: 'segments' | 'sequence') {
    this.#queue.push({ kind: 'mode', value, resolve: () => {}, reject: () => {} });
    this.#processQueue();
  }

  // ── Queue processor ───────────────────────────────────────────────────────

  #processQueue(): void {
    if (this.#isProcessing || this.#queue.length === 0) {
      return;
    }

    this.#isProcessing = true;
    const operation    = this.#queue[0]!;

    const h = {
      onSuccess: () => {
        this.#sourceBuffer.removeEventListener('updateend', h.onSuccess);
        this.#sourceBuffer.removeEventListener('error', h.onError);
        operation.resolve();
        this.#queue.shift();
        this.#isProcessing = false;
        this.#processQueue();
      },
      onError: () => {
        this.#sourceBuffer.removeEventListener('updateend', h.onSuccess);
        this.#sourceBuffer.removeEventListener('error', h.onError);
        const error = new Error('SourceBuffer error occurred');
        const ops   = this.#queue.splice(0);

        this.#isProcessing = false;
        for (const op of ops) {
          op.reject(error);
        }
      }
    };

    try {
      switch (operation.kind) {
        case 'append':
          this.#sourceBuffer.addEventListener('updateend', h.onSuccess);
          this.#sourceBuffer.addEventListener('error', h.onError);
          this.#sourceBuffer.appendBuffer(operation.data as BufferSource);
          break;
        case 'remove':
          this.#sourceBuffer.addEventListener('updateend', h.onSuccess);
          this.#sourceBuffer.addEventListener('error', h.onError);
          this.#sourceBuffer.remove(operation.start, operation.end);
          break;
        case 'abort':
          if (this.#sourceBuffer.updating) {
            this.#sourceBuffer.addEventListener('updateend', h.onSuccess);
            this.#sourceBuffer.addEventListener('error', h.onError);
            this.#sourceBuffer.abort();
          } else {
            operation.resolve();
            this.#queue.shift();
            this.#isProcessing = false;
            this.#processQueue();
          }
          break;
        case 'changeType':
          // Synchronous — no updateend fired. Executes in order after all
          // preceding appends/removes have settled.
          this.#sourceBuffer.changeType(operation.mimeAndCodecs);
          operation.resolve();
          this.#queue.shift();
          this.#isProcessing = false;
          this.#processQueue();
          break;
        case 'timestampOffset':
          // Synchronous — no updateend fired.
          this.#sourceBuffer.timestampOffset = operation.value;
          operation.resolve();
          this.#queue.shift();
          this.#isProcessing = false;
          this.#processQueue();
          break;
        case 'appendWindowStart':
          this.#sourceBuffer.appendWindowStart = operation.value;
          operation.resolve();
          this.#queue.shift();
          this.#isProcessing = false;
          this.#processQueue();
          break;
        case 'appendWindowEnd':
          this.#sourceBuffer.appendWindowEnd = operation.value;
          operation.resolve();
          this.#queue.shift();
          this.#isProcessing = false;
          this.#processQueue();
          break;
        case 'mode':
          this.#sourceBuffer.mode = operation.value;
          operation.resolve();
          this.#queue.shift();
          this.#isProcessing = false;
          this.#processQueue();
          break;
      }
    } catch (error) {
      this.#sourceBuffer.removeEventListener('updateend', h.onSuccess);
      this.#sourceBuffer.removeEventListener('error', h.onError);
      const ops = this.#queue.splice(0);
      this.#isProcessing = false;
      for (const op of ops) {
        op.reject(error as Error);
      }
    }
  }
}
