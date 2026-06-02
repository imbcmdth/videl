/**
 * ManagedSourceBuffer is a promise-based wrapper around the browser's event-driven
 * SourceBuffer API. It serializes concurrent operations internally and surfaces
 * errors as rejected promises.
 */
export class ManagedSourceBuffer {
  private sourceBuffer: SourceBuffer;
  private queue: Array<{
    kind: 'append' | 'remove' | 'abort' | 'changeType';
    args: any[];
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  private isProcessing = false;

  constructor(sourceBuffer: SourceBuffer) {
    this.sourceBuffer = sourceBuffer;
  }

  /**
   * Append bytes. Queued if another operation is in progress.
   */
  async append(data: ArrayBuffer | ArrayBufferView): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({
        kind: 'append',
        args: [data],
        resolve,
        reject
      });
      this.processQueue();
    });
  }

  /**
   * Remove buffered range [start, end) in seconds. Queued.
   */
  async remove(start: number, end: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({
        kind: 'remove',
        args: [start, end],
        resolve,
        reject
      });
      this.processQueue();
    });
  }

  /**
   * Abort the current operation; clears the pending queue; resolves when settled.
   */
  async abort(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({
        kind: 'abort',
        args: [],
        resolve,
        reject
      });
      this.processQueue();
    });
  }

  /**
   * Synchronous. Change the MIME+codecs type of the underlying SourceBuffer.
   * Call before the next append when a codec switch is needed.
   * Throws if the browser does not support SourceBuffer.changeType().
   */
  changeType(type: string): void {
    this.sourceBuffer.changeType(type);
  }

  /**
   * True while an async operation is in progress.
   */
  get updating(): boolean {
    return this.sourceBuffer.updating;
  }

  /**
   * Live TimeRanges from the underlying SourceBuffer.
   */
  get buffered(): TimeRanges {
    return this.sourceBuffer.buffered;
  }

  private processQueue(): void {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const operation = this.queue[0];

    const resolve = () => {
      operation.resolve();
      this.queue.shift();
      this.isProcessing = false;
      this.processQueue(); // Process next operation
    };

    const reject = (error: Error) => {
      operation.reject(error);
      this.queue.shift();
      this.isProcessing = false;
      this.processQueue(); // Process next operation
    };

    try {
      switch (operation.kind) {
        case 'append':
          this.sourceBuffer.addEventListener('updateend', resolve);
          this.sourceBuffer.addEventListener('error', (event) => {
            const error = new Error('SourceBuffer error occurred');
            reject(error);
          });
          this.sourceBuffer.appendBuffer(operation.args[0]);
          break;
        case 'remove':
          this.sourceBuffer.addEventListener('updateend', resolve);
          this.sourceBuffer.addEventListener('error', (event) => {
            const error = new Error('SourceBuffer error occurred');
            reject(error);
          });
          this.sourceBuffer.remove(operation.args[0], operation.args[1]);
          break;
        case 'abort':
          // For abort, we need to handle it specially
          this.sourceBuffer.addEventListener('updateend', resolve);
          this.sourceBuffer.addEventListener('error', (event) => {
            const error = new Error('SourceBuffer error occurred');
            reject(error);
          });
          this.sourceBuffer.abort();
          break;
      }
    } catch (error) {
      reject(error as Error);
    }
  }
}