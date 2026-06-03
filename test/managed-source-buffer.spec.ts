import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const MODULE_PATH = path.join(__dirname, '../dist/index.js');
const MIME = 'video/mp4; codecs="avc1.64001e"';

// Read fixtures once at module load time
const INIT_BYTES = Array.from(fs.readFileSync(path.join(FIXTURE_DIR, 'video-init.mp4')));
const SEG1_BYTES = Array.from(fs.readFileSync(path.join(FIXTURE_DIR, 'video-seg1.mp4')));

test.describe('ManagedSourceBuffer', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/dist/index.js', route =>
      route.fulfill({
        contentType: 'application/javascript; charset=utf-8',
        body: fs.readFileSync(MODULE_PATH, 'utf8'),
      })
    );
    await page.route('http://localhost:3000/', route =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!DOCTYPE html><html><body><video id="video"></video></body></html>`,
      })
    );
    await page.goto('http://localhost:3000/');
  });

  test('should append data successfully', async ({ page }) => {
    const result = await page.evaluate(
      async ({ mimeStr, initArr, segArr }: { mimeStr: string; initArr: number[]; segArr: number[] }) => {
        const mediaSource = new MediaSource();
        const video = document.getElementById('video') as HTMLVideoElement;
        video.src = URL.createObjectURL(mediaSource);

        await new Promise<void>(resolve => {
          mediaSource.addEventListener('sourceopen', () => resolve(), { once: true });
        });

        const sourceBuffer = mediaSource.addSourceBuffer(mimeStr);
        const { ManagedSourceBuffer } = await import('/dist/index.js');
        const msb = new ManagedSourceBuffer(sourceBuffer);

        try {
          // Append init segment followed by a media segment
          await msb.append(new Uint8Array(initArr).buffer);
          await msb.append(new Uint8Array(segArr).buffer);
          return { success: true };
        } catch (error: any) {
          return { success: false, error: error.message };
        }
      },
      { mimeStr: MIME, initArr: INIT_BYTES, segArr: SEG1_BYTES }
    );

    expect(result.success).toBe(true);
  });

  test('should handle concurrent operations correctly', async ({ page }) => {
    const result = await page.evaluate(
      async ({ mimeStr, initArr, segArr }: { mimeStr: string; initArr: number[]; segArr: number[] }) => {
        const mediaSource = new MediaSource();
        const video = document.getElementById('video') as HTMLVideoElement;
        video.src = URL.createObjectURL(mediaSource);

        await new Promise<void>(resolve => {
          mediaSource.addEventListener('sourceopen', () => resolve(), { once: true });
        });

        // Prime the buffer with the init segment first (synchronous serialisation
        // handles this; we await it before queuing concurrent media segments)
        const sourceBuffer = mediaSource.addSourceBuffer(mimeStr);
        const { ManagedSourceBuffer } = await import('/dist/index.js');
        const msb = new ManagedSourceBuffer(sourceBuffer);
        await msb.append(new Uint8Array(initArr).buffer);

        try {
          // Queue two media-segment appends concurrently; the queue must serialise them
          const append1 = msb.append(new Uint8Array(segArr).buffer);
          // Remove range between appends so timestamps don't conflict
          const remove1 = msb.remove(0, 100);
          const append2 = msb.append(new Uint8Array(segArr).buffer);

          await Promise.all([append1, remove1, append2]);
          return { success: true };
        } catch (error: any) {
          return { success: false, error: error.message };
        }
      },
      { mimeStr: MIME, initArr: INIT_BYTES, segArr: SEG1_BYTES }
    );

    expect(result.success).toBe(true);
  });
});
