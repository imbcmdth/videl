/**
 * SyntheticTimeRanges — unit tests.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const MODULE_PATH = path.join(__dirname, '../dist/index.js');

test.beforeEach(async ({ page }) => {
  await page.route('**/dist/index.js', route =>
    route.fulfill({
      contentType: 'application/javascript; charset=utf-8',
      body: fs.readFileSync(MODULE_PATH, 'utf8'),
    })
  );
  await page.route('http://localhost:3000/', route =>
    route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' })
  );
  await page.goto('http://localhost:3000/');
});

// Helper: snapshot a SyntheticTimeRanges into a plain array of [start,end] pairs.
const SNAPSHOT = `
function snapshot(r: any) {
  const out = [];
  for (let i = 0; i < r.length; i++) out.push([r.start(i), r.end(i)]);
  return out;
}
`;

test.describe('SyntheticTimeRanges', () => {
  test('starts empty', async ({ page }) => {
    const len = await page.evaluate(async () => {
      const { SyntheticTimeRanges } = await import('/dist/index.js');
      return new SyntheticTimeRanges().length;
    });
    expect(len).toBe(0);
  });

  test('add() inserts a range', async ({ page }) => {
    const ranges = await page.evaluate(async () => {
      const { SyntheticTimeRanges } = await import('/dist/index.js');
      function snapshot(r: any) { const out = []; for (let i=0;i<r.length;i++) out.push([r.start(i),r.end(i)]); return out; }
      const r = new SyntheticTimeRanges();
      r.add(1, 5);
      return snapshot(r);
    });
    expect(ranges).toEqual([[1, 5]]);
  });

  test('add() merges overlapping ranges', async ({ page }) => {
    const ranges = await page.evaluate(async () => {
      const { SyntheticTimeRanges } = await import('/dist/index.js');
      function snapshot(r: any) { const out = []; for (let i=0;i<r.length;i++) out.push([r.start(i),r.end(i)]); return out; }
      const r = new SyntheticTimeRanges();
      r.add(1, 5);
      r.add(3, 8);
      return snapshot(r);
    });
    expect(ranges).toEqual([[1, 8]]);
  });

  test('add() merges touching ranges', async ({ page }) => {
    const ranges = await page.evaluate(async () => {
      const { SyntheticTimeRanges } = await import('/dist/index.js');
      function snapshot(r: any) { const out = []; for (let i=0;i<r.length;i++) out.push([r.start(i),r.end(i)]); return out; }
      const r = new SyntheticTimeRanges();
      r.add(0, 5);
      r.add(5, 10);
      return snapshot(r);
    });
    expect(ranges).toEqual([[0, 10]]);
  });

  test('add() keeps disjoint ranges separate and sorted', async ({ page }) => {
    const ranges = await page.evaluate(async () => {
      const { SyntheticTimeRanges } = await import('/dist/index.js');
      function snapshot(r: any) { const out = []; for (let i=0;i<r.length;i++) out.push([r.start(i),r.end(i)]); return out; }
      const r = new SyntheticTimeRanges();
      r.add(10, 20);
      r.add(0, 5);
      return snapshot(r);
    });
    expect(ranges).toEqual([[0, 5], [10, 20]]);
  });

  test('add() with start >= end is a no-op', async ({ page }) => {
    const len = await page.evaluate(async () => {
      const { SyntheticTimeRanges } = await import('/dist/index.js');
      const r = new SyntheticTimeRanges();
      r.add(5, 5);
      r.add(6, 4);
      return r.length;
    });
    expect(len).toBe(0);
  });

  test('cut() removes a contained range entirely', async ({ page }) => {
    const ranges = await page.evaluate(async () => {
      const { SyntheticTimeRanges } = await import('/dist/index.js');
      function snapshot(r: any) { const out = []; for (let i=0;i<r.length;i++) out.push([r.start(i),r.end(i)]); return out; }
      const r = new SyntheticTimeRanges();
      r.add(0, 10);
      r.cut(2, 8);
      return snapshot(r);
    });
    expect(ranges).toEqual([[0, 2], [8, 10]]);
  });

  test('cut() removes a range that covers an entire entry', async ({ page }) => {
    const ranges = await page.evaluate(async () => {
      const { SyntheticTimeRanges } = await import('/dist/index.js');
      function snapshot(r: any) { const out = []; for (let i=0;i<r.length;i++) out.push([r.start(i),r.end(i)]); return out; }
      const r = new SyntheticTimeRanges();
      r.add(2, 5);
      r.cut(0, 10);
      return snapshot(r);
    });
    expect(ranges).toEqual([]);
  });

  test('cut() trims the end of a range', async ({ page }) => {
    const ranges = await page.evaluate(async () => {
      const { SyntheticTimeRanges } = await import('/dist/index.js');
      function snapshot(r: any) { const out = []; for (let i=0;i<r.length;i++) out.push([r.start(i),r.end(i)]); return out; }
      const r = new SyntheticTimeRanges();
      r.add(0, 10);
      r.cut(5, Infinity);
      return snapshot(r);
    });
    expect(ranges).toEqual([[0, 5]]);
  });

  test('cut() trims the start of a range', async ({ page }) => {
    const ranges = await page.evaluate(async () => {
      const { SyntheticTimeRanges } = await import('/dist/index.js');
      function snapshot(r: any) { const out = []; for (let i=0;i<r.length;i++) out.push([r.start(i),r.end(i)]); return out; }
      const r = new SyntheticTimeRanges();
      r.add(0, 10);
      r.cut(0, 4);
      return snapshot(r);
    });
    expect(ranges).toEqual([[4, 10]]);
  });

  test('cut() is a no-op when no overlap', async ({ page }) => {
    const ranges = await page.evaluate(async () => {
      const { SyntheticTimeRanges } = await import('/dist/index.js');
      function snapshot(r: any) { const out = []; for (let i=0;i<r.length;i++) out.push([r.start(i),r.end(i)]); return out; }
      const r = new SyntheticTimeRanges();
      r.add(5, 10);
      r.cut(0, 4);
      return snapshot(r);
    });
    expect(ranges).toEqual([[5, 10]]);
  });

  test('clear() removes all ranges', async ({ page }) => {
    const len = await page.evaluate(async () => {
      const { SyntheticTimeRanges } = await import('/dist/index.js');
      const r = new SyntheticTimeRanges();
      r.add(0, 5);
      r.add(10, 20);
      r.clear();
      return r.length;
    });
    expect(len).toBe(0);
  });

  test('start()/end() throw on out-of-bounds index', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { SyntheticTimeRanges } = await import('/dist/index.js');
      const r = new SyntheticTimeRanges();
      try { r.start(0); return 'no-throw'; } catch { return 'threw'; }
    });
    expect(result).toBe('threw');
  });
});
