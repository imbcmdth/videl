/**
 * classifyTextCodec / classifyTextMimeAndCodecs — unit tests.
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

test.describe('classifyTextCodec', () => {
  test('wvtt → kind:wvtt', async ({ page }) => {
    const kind = await page.evaluate(async () => {
      const { classifyTextCodec } = await import('/dist/index.js');
      return classifyTextCodec('wvtt').kind;
    });
    expect(kind).toBe('wvtt');
  });

  test('stpp → kind:stpp-text', async ({ page }) => {
    const kind = await page.evaluate(async () => {
      const { classifyTextCodec } = await import('/dist/index.js');
      return classifyTextCodec('stpp').kind;
    });
    expect(kind).toBe('stpp-text');
  });

  test('stpp.ttml.im1t → kind:stpp-text', async ({ page }) => {
    const kind = await page.evaluate(async () => {
      const { classifyTextCodec } = await import('/dist/index.js');
      return classifyTextCodec('stpp.ttml.im1t').kind;
    });
    expect(kind).toBe('stpp-text');
  });

  test('stpp.ttml.im2t → kind:stpp-text', async ({ page }) => {
    const kind = await page.evaluate(async () => {
      const { classifyTextCodec } = await import('/dist/index.js');
      return classifyTextCodec('stpp.ttml.im2t').kind;
    });
    expect(kind).toBe('stpp-text');
  });

  test('stpp.ttml.etd1 → kind:stpp-text', async ({ page }) => {
    const kind = await page.evaluate(async () => {
      const { classifyTextCodec } = await import('/dist/index.js');
      return classifyTextCodec('stpp.ttml.etd1').kind;
    });
    expect(kind).toBe('stpp-text');
  });

  test('stpp.ttml.im1i → kind:stpp-image', async ({ page }) => {
    const kind = await page.evaluate(async () => {
      const { classifyTextCodec } = await import('/dist/index.js');
      return classifyTextCodec('stpp.ttml.im1i').kind;
    });
    expect(kind).toBe('stpp-image');
  });

  test('stpp.ttml.im2i → kind:stpp-image', async ({ page }) => {
    const kind = await page.evaluate(async () => {
      const { classifyTextCodec } = await import('/dist/index.js');
      return classifyTextCodec('stpp.ttml.im2i').kind;
    });
    expect(kind).toBe('stpp-image');
  });

  test('unknown string → kind:unknown', async ({ page }) => {
    const kind = await page.evaluate(async () => {
      const { classifyTextCodec } = await import('/dist/index.js');
      return classifyTextCodec('av01.0.00M.08').kind;
    });
    expect(kind).toBe('unknown');
  });

  test('codec string is case-insensitive', async ({ page }) => {
    const kind = await page.evaluate(async () => {
      const { classifyTextCodec } = await import('/dist/index.js');
      return classifyTextCodec('WVTT').kind;
    });
    expect(kind).toBe('wvtt');
  });
});

test.describe('classifyTextMimeAndCodecs', () => {
  test('extracts codec from mime+codecs string', async ({ page }) => {
    const kind = await page.evaluate(async () => {
      const { classifyTextMimeAndCodecs } = await import('/dist/index.js');
      return classifyTextMimeAndCodecs('application/mp4; codecs="wvtt"').kind;
    });
    expect(kind).toBe('wvtt');
  });

  test('extracts first codec from comma-separated list', async ({ page }) => {
    const kind = await page.evaluate(async () => {
      const { classifyTextMimeAndCodecs } = await import('/dist/index.js');
      return classifyTextMimeAndCodecs('application/mp4; codecs="stpp.ttml.im1t, stpp"').kind;
    });
    expect(kind).toBe('stpp-text');
  });

  test('bare codec string (no mime) is classified correctly', async ({ page }) => {
    const kind = await page.evaluate(async () => {
      const { classifyTextMimeAndCodecs } = await import('/dist/index.js');
      return classifyTextMimeAndCodecs('stpp.ttml.im1i').kind;
    });
    expect(kind).toBe('stpp-image');
  });

  test('empty string → kind:unknown', async ({ page }) => {
    const kind = await page.evaluate(async () => {
      const { classifyTextMimeAndCodecs } = await import('/dist/index.js');
      return classifyTextMimeAndCodecs('').kind;
    });
    expect(kind).toBe('unknown');
  });
});
