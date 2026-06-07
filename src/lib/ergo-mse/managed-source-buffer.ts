import type { ISourceBuffer } from './i-source-buffer';

type MsbQueueEntry =
  | { kind: 'append';          data: ArrayBuffer | ArrayBufferView; resolve: () => void; reject: (e: Error) => void }
  | { kind: 'remove';          start: number; end: number;           resolve: () => void; reject: (e: Error) => void }
  | { kind: 'abort';                                                  resolve: () => void; reject: (e: Error) => void }
  | { kind: 'changeType';      mimeAndCodecs: string;                resolve: () => void; reject: (e: Error) => void }
  | { kind: 'timestampOffset'; value: number;                        resolve: () => void; reject: (e: Error) => void };

/**
 * ManagedSourceBuffer is a promise-based wrapper around the browser's event-driven
 * SourceBuffer API. It serializes concurrent operations internally and surfaces
 * errors as rejected promises.
 *
 * Implements ISourceBuffer so it is interchangeable with TextSourceBuffer
 * throughout the element tree.
 */
export class ManagedSourceBuffer implements ISourceBuffer {
  private sourceBuffer: SourceBuffer;
  private queue: Array<MsbQueueEntry> = [];
  private isProcessing = false;

  constructor(sourceBuffer: SourceBuffer) {
    this.sourceBuffer = sourceBuffer;
  }

  /**
   * Append bytes. Queued if another operation is in progress.
   */
  async append(data: ArrayBuffer | ArrayBufferView): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ kind: 'append', data, resolve, reject });
      this.processQueue();
    });
  }

  /**
   * Remove buffered range [start, end) in seconds. Queued.
   */
  async remove(start: number, end: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ kind: 'remove', start, end, resolve, reject });
      this.processQueue();
    });
  }

  /**
   * Abort the current operation; clears the pending queue; resolves when settled.
   */
  async abort(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const startIdx = this.isProcessing ? 1 : 0;
      const drained  = this.queue.splice(startIdx);
      for (const op of drained) {
        op.reject(new Error('Aborted'));
      }

      if (!this.isProcessing) {
        resolve(); return;
      }

      this.queue.push({ kind: 'abort', resolve, reject });
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
    this.queue.push({ kind: 'changeType', mimeAndCodecs: type, resolve: () => {}, reject: () => {} });
    this.processQueue();
  }

  get updating(): boolean {
    return this.sourceBuffer.updating;
  }
  get buffered(): TimeRanges {
    return this.sourceBuffer.buffered;
  }

  /**
   * Offset (seconds) added to decoded media timestamps to produce presentation
   * times. Corresponds to SourceBuffer.timestampOffset.
   *
   * Set by videl-representation after the init segment is appended, using the
   * value stamped on the representation element by the MPD parser:
   *   timestampOffset = periodStart − presentationTimeOffset / timescale
   */
  get timestampOffset(): number {
    return this.sourceBuffer.timestampOffset;
  }

  /**
   * Queued. The assignment to the underlying SourceBuffer is deferred until all
   * preceding operations have completed, so it cannot be applied while an append
   * or remove is in progress. The getter continues to reflect the SourceBuffer's
   * current (last-applied) value until the queued assignment executes.
   */
  set timestampOffset(v: number) {
    this.queue.push({ kind: 'timestampOffset', value: v, resolve: () => {}, reject: () => {} });
    this.processQueue();
  }

  private processQueue(): void {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing  = true;
    const operation    = this.queue[0];

    const h = {
      onSuccess: () => {
        this.sourceBuffer.removeEventListener('updateend', h.onSuccess);
        this.sourceBuffer.removeEventListener('error', h.onError);
        operation.resolve();
        this.queue.shift();
        this.isProcessing = false;
        this.processQueue();
      },
      onError: () => {
        this.sourceBuffer.removeEventListener('updateend', h.onSuccess);
        this.sourceBuffer.removeEventListener('error', h.onError);
        const error = new Error('SourceBuffer error occurred');
        const ops   = this.queue.splice(0);

        this.isProcessing = false;
        for (const op of ops) {
          op.reject(error);
        }
      }
    };

    try {
      switch (operation.kind) {
        case 'append':
          this.sourceBuffer.addEventListener('updateend', h.onSuccess);
          this.sourceBuffer.addEventListener('error', h.onError);
          this.sourceBuffer.appendBuffer(operation.data as BufferSource);
          break;
        case 'remove':
          this.sourceBuffer.addEventListener('updateend', h.onSuccess);
          this.sourceBuffer.addEventListener('error', h.onError);
          this.sourceBuffer.remove(operation.start, operation.end);
          break;
        case 'abort':
          if (this.sourceBuffer.updating) {
            this.sourceBuffer.addEventListener('updateend', h.onSuccess);
            this.sourceBuffer.addEventListener('error', h.onError);
            this.sourceBuffer.abort();
          } else {
            operation.resolve();
            this.queue.shift();
            this.isProcessing = false;
            this.processQueue();
          }
          break;
        case 'changeType':
          // Synchronous — no updateend fired. Executes in order after all
          // preceding appends/removes have settled.
          this.sourceBuffer.changeType(operation.mimeAndCodecs);
          operation.resolve();
          this.queue.shift();
          this.isProcessing = false;
          this.processQueue();
          break;
        case 'timestampOffset':
          // Synchronous — no updateend fired.
          this.sourceBuffer.timestampOffset = operation.value;
          operation.resolve();
          this.queue.shift();
          this.isProcessing = false;
          this.processQueue();
          break;
      }
    } catch (error) {
      this.sourceBuffer.removeEventListener('updateend', h.onSuccess);
      this.sourceBuffer.removeEventListener('error', h.onError);
      const ops = this.queue.splice(0);
      this.isProcessing = false;
      for (const op of ops) {
        op.reject(error as Error);
      }
    }
  }
}
