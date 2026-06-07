/**
 * ManagedSourceBuffer — Playwright browser tests.
 * All criteria from DEL-000 acceptance criteria 3–12.
 *
 * Setup: loads the IIFE bundle, creates a real MediaSource + SourceBuffer per
 * test, and wraps it with ManagedSourceBuffer in the browser context.
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const INIT_BYTES = Array.from(fs.readFileSync(path.join(FIXTURE_DIR, 'video-init.mp4')));
const SEG1_BYTES = Array.from(fs.readFileSync(path.join(FIXTURE_DIR, 'video-seg1.mp4')));
const MIME = 'video/mp4; codecs="avc1.64001e"';
const MODULE_PATH = path.join(__dirname, "../dist/index.js");

// ---------------------------------------------------------------------------
// Per-test page setup
// ---------------------------------------------------------------------------
async function setup(page: Page) {
  // Serve dist/index.js from disk so the browser can import it by URL.
  await page.route('**/dist/index.js', route =>
    route.fulfill({
      contentType: 'application/javascript; charset=utf-8',
      body: fs.readFileSync(MODULE_PATH, 'utf8'),
    })
  );
  // Serve a minimal HTML shell at the baseURL origin.
  await page.route('http://localhost:3000/', route =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!DOCTYPE html><html><body><video id="v" muted playsinline></video></body></html>`,
    })
  );
  await page.goto('http://localhost:3000/');

  // Boot MediaSource + SourceBuffer in the page, expose window.msb
  await page.evaluate(
    async ({ mimeStr, initArr }: { mimeStr: string; initArr: number[] }) => {
      const { ManagedSourceBuffer } = await import('/dist/index.js');
      return new Promise<void>((resolve, reject) => {
        const ms = new MediaSource();
        const video = document.getElementById('v') as HTMLVideoElement;
        video.src = URL.createObjectURL(ms);
        ms.addEventListener('sourceopen', () => {
          try {
            const sb = ms.addSourceBuffer(mimeStr);
            (window as any).msb = new ManagedSourceBuffer(sb);
            (window as any)._sb = sb;
            // Append init segment so the buffer is ready for media segments
            sb.addEventListener('updateend', () => resolve(), { once: true });
            sb.appendBuffer(new Uint8Array(initArr));
          } catch (e) { reject(e); }
        }, { once: true });
      });
    },
    { mimeStr: MIME, initArr: INIT_BYTES }
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('ManagedSourceBuffer', () => {

  // Criterion 3: append resolves after updateend
  test('append resolves after updateend fires', async ({ page }) => {
    await setup(page);
    const result = await page.evaluate(
      ({ seg }: { seg: number[] }) =>
        (window as any).msb.append(new Uint8Array(seg).buffer).then(() => 'resolved'),
      { seg: SEG1_BYTES }
    );
    expect(result).toBe('resolved');
  });

  // Criterion 4: append rejects on SourceBuffer error
  test('append rejects when SourceBuffer fires error', async ({ page }) => {
    await setup(page);
    const result = await page.evaluate(() => {
      const garbage = new ArrayBuffer(16); // invalid fMP4 → MSE error
      return (window as any).msb
        .append(garbage)
        .then(() => 'resolved')
        .catch((e: Error) => `rejected:${e.message}`);
    });
    expect(result).toMatch(/^rejected:/);
  });

  // Criteria 5+6: serialisation — second operation does not start until first updateend
  test('concurrent operations are serialised', async ({ page }) => {
    await setup(page);
    const log = await page.evaluate(
      ({ seg }: { seg: number[] }) => {
        const msb = (window as any).msb;
        const sb = (window as any)._sb as SourceBuffer;
        const events: string[] = [];

        sb.addEventListener('updateend', () => events.push('updateend'));

        // First op: append a segment
        const p1 = msb.append(new Uint8Array(seg).buffer)
          .then(() => events.push('p1-done'));
        // Second op: remove — avoids duplicate-timestamp MSE error
        const p2 = msb.remove(0, 100)
          .then(() => events.push('p2-done'));

        return Promise.all([p1, p2]).then(() => events);
      },
      { seg: SEG1_BYTES }
    );
    // p1 must complete before p2 starts
    const idxP1 = log.indexOf('p1-done');
    const idxP2 = log.indexOf('p2-done');
    expect(idxP1).toBeGreaterThanOrEqual(0);
    expect(idxP2).toBeGreaterThan(idxP1);
  });

  // Criterion 7: remove resolves after updateend
  test('remove resolves after updateend', async ({ page }) => {
    await setup(page);
    // Append a segment so there's something to remove
    await page.evaluate(
      ({ seg }: { seg: number[] }) =>
        (window as any).msb.append(new Uint8Array(seg).buffer),
      { seg: SEG1_BYTES }
    );
    const result = await page.evaluate(() =>
      (window as any).msb.remove(0, 100).then(() => 'resolved')
    );
    expect(result).toBe('resolved');
  });

  // Criterion 8: abort clears queue and resolves
  test('abort: rejects queued ops and resolves itself', async ({ page }) => {
    await setup(page);
    const results = await page.evaluate(
      ({ seg }: { seg: number[] }) => {
        const msb = (window as any).msb;
        const out: string[] = [];
        // Queue two appends then immediately abort
        msb.append(new Uint8Array(seg).buffer)
          .then(() => out.push('p1-resolved'))
          .catch(() => out.push('p1-rejected'));
        msb.append(new Uint8Array(seg).buffer)
          .then(() => out.push('p2-resolved'))
          .catch(() => out.push('p2-rejected'));
        return msb.abort()
          .then(() => { out.push('abort-resolved'); return out; })
          .catch(() => { out.push('abort-rejected'); return out; });
      },
      { seg: SEG1_BYTES }
    );
    expect(results).toContain('abort-resolved');
    expect(results).toContain('p2-rejected');
    expect(results).not.toContain('p2-resolved');
  });

  // Criterion 12: error on first op rejects all queued ops
  test('SourceBuffer error flushes and rejects entire queue', async ({ page }) => {
    await setup(page);
    const results = await page.evaluate(
      ({ seg }: { seg: number[] }) => {
        const msb = (window as any).msb;
        const out: string[] = [];
        const garbage = new ArrayBuffer(16);
        msb.append(garbage)
          .then(() => out.push('p1-resolved'))
          .catch(() => out.push('p1-rejected'));
        msb.append(new Uint8Array(seg).buffer)
          .then(() => out.push('p2-resolved'))
          .catch(() => out.push('p2-rejected'));
        return Promise.all([
          msb.append(garbage).catch(() => {}),
          new Promise(r => setTimeout(r, 500))
        ]).then(() => out);
      },
      { seg: SEG1_BYTES }
    );
    expect(results).toContain('p1-rejected');
    expect(results).toContain('p2-rejected');
    expect(results).not.toContain('p2-resolved');
  });

  // Criterion 9: changeType
  test('changeType delegates to SourceBuffer.changeType', async ({ page }) => {
    await setup(page);
    const result = await page.evaluate(() => {
      try {
        (window as any).msb.changeType('video/mp4; codecs="avc1.4d401f"');
        return 'ok';
      } catch (e: any) {
        return `threw:${e.message}`;
      }
    });
    expect(result).toBe('ok');
  });

  // changeType is queued: when called after append() the SourceBuffer must
  // not be in the 'updating' state when changeType actually executes.
  test('changeType is queued and runs after a preceding append settles', async ({ page }) => {
    await setup(page);
    const log = await page.evaluate(
      ({ seg }: { seg: number[] }) => {
        const msb = (window as any).msb;
        const sb  = (window as any)._sb as SourceBuffer;
        const events: string[] = [];

        sb.addEventListener('updateend', () => events.push('updateend'));

        // Queue an append, then immediately call changeType without awaiting.
        // If changeType were synchronous it would throw InvalidStateError because
        // the SourceBuffer is updating; being queued it must wait for updateend.
        const p1 = msb.append(new Uint8Array(seg).buffer)
          .then(() => events.push('append-done'));

        // changeType queued — must not run until p1 resolves.
        msb.changeType('video/mp4; codecs="avc1.4d401f"');
        events.push('changeType-called');

        return p1.then(() => events);
      },
      { seg: SEG1_BYTES }
    );
    // changeType-called is pushed synchronously (before updateend fires).
    // append-done follows updateend.
    // The important invariant: changeType-called appears BEFORE append-done,
    // confirming changeType was queued (not executed) when it was called.
    expect(log.indexOf('changeType-called')).toBeLessThan(log.indexOf('append-done'));
    // updateend must fire before append-done is pushed.
    expect(log.indexOf('updateend')).toBeLessThan(log.indexOf('append-done'));
  });

  // timestampOffset is queued: setting it while an append is in flight must
  // not attempt to write the property while updating === true.
  test('timestampOffset assignment is queued and applied after pending append', async ({ page }) => {
    await setup(page);
    const result = await page.evaluate(
      ({ seg }: { seg: number[] }) => {
        const msb = (window as any).msb;
        const sb  = (window as any)._sb as SourceBuffer;
        let updatingAtAssignment = false;

        // Intercept the actual property write on the underlying SourceBuffer
        // to capture whether updating was true when the assignment happened.
        const orig = Object.getOwnPropertyDescriptor(SourceBuffer.prototype, 'timestampOffset')!;
        Object.defineProperty(sb, 'timestampOffset', {
          get: orig.get!.bind(sb),
          set(v: number) {
            updatingAtAssignment = sb.updating;
            orig.set!.call(sb, v);
          },
          configurable: true,
        });

        const p = msb.append(new Uint8Array(seg).buffer);
        // Set timestampOffset while the append has been initiated.
        msb.timestampOffset = 0;  // queued — must not write while updating

        return p.then(() => ({ updatingAtAssignment }));
      },
      { seg: SEG1_BYTES }
    );
    expect(result.updatingAtAssignment).toBe(false);
  });

  // Criteria 10+11: getters proxy the SourceBuffer
  test('updating and buffered getters proxy underlying SourceBuffer', async ({ page }) => {
    await setup(page);
    const { updatingMatch, bufferedLengthMatch, bufferedStartMatch } = await page.evaluate(() => {
      const msb = (window as any).msb;
      const sb = (window as any)._sb as SourceBuffer;
      // TimeRanges returns a new object per access so === will always be false.
      // Compare contents instead.
      return {
        updatingMatch: msb.updating === sb.updating,
        bufferedLengthMatch: msb.buffered.length === sb.buffered.length,
        bufferedStartMatch:
          msb.buffered.length === 0 ||
          msb.buffered.start(0) === sb.buffered.start(0),
      };
    });
    expect(updatingMatch).toBe(true);
    expect(bufferedLengthMatch).toBe(true);
    expect(bufferedStartMatch).toBe(true);
  });
});
