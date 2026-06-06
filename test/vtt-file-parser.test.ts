/**
 * VTT file parser (parseVttFile) — unit tests.
 *
 * Tests the standalone WebVTT file parser, distinct from the wvtt ISOBMFF
 * sample parser. Strings are passed as page.evaluate template literals so
 * TypeScript doesn't need to resolve browser-context identifiers.
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

const enc = (s: string) =>
  `new TextEncoder().encode(${JSON.stringify(s)})`;

test.describe('parseVttFile', () => {

  test('returns empty array for non-VTT content', async ({ page }) => {
    const count = await page.evaluate(`(async () => {
      const { parseVttFile } = await import('/dist/index.js');
      return parseVttFile(new TextEncoder().encode('not webvtt')).length;
    })()`);
    expect(count).toBe(0);
  });

  test('parses a single cue with id', async ({ page }) => {
    const result = await page.evaluate(`(async () => {
      const { parseVttFile } = await import('/dist/index.js');
      const vtt = [
        'WEBVTT',
        '',
        'cue-1',
        '00:00:01.000 --> 00:00:02.500',
        'Hello world',
        '',
      ].join('\\n');
      const cues = parseVttFile(new TextEncoder().encode(vtt));
      return cues[0] ?? null;
    })()`);
    expect((result as any).id).toBe('cue-1');
    expect((result as any).startTime).toBeCloseTo(1.0, 3);
    expect((result as any).endTime).toBeCloseTo(2.5, 3);
    expect((result as any).payload).toBe('Hello world');
  });

  test('parses a cue without an id', async ({ page }) => {
    const result = await page.evaluate(`(async () => {
      const { parseVttFile } = await import('/dist/index.js');
      const vtt = [
        'WEBVTT',
        '',
        '00:00:00.000 --> 00:00:01.000',
        'No ID cue',
        '',
      ].join('\\n');
      const cues = parseVttFile(new TextEncoder().encode(vtt));
      return { id: cues[0]?.id, payload: cues[0]?.payload };
    })()`);
    expect((result as any).id).toBe('');
    expect((result as any).payload).toBe('No ID cue');
  });

  test('parses multiple cues in sequence', async ({ page }) => {
    const count = await page.evaluate(`(async () => {
      const { parseVttFile } = await import('/dist/index.js');
      const vtt = [
        'WEBVTT',
        '',
        '00:00:00.000 --> 00:00:01.000',
        'First',
        '',
        '00:00:01.000 --> 00:00:02.000',
        'Second',
        '',
        '00:00:02.000 --> 00:00:03.000',
        'Third',
        '',
      ].join('\\n');
      return parseVttFile(new TextEncoder().encode(vtt)).length;
    })()`);
    expect(count).toBe(3);
  });

  test('parses multi-line cue payload', async ({ page }) => {
    const payload = await page.evaluate(`(async () => {
      const { parseVttFile } = await import('/dist/index.js');
      const vtt = [
        'WEBVTT',
        '',
        '00:00:00.000 --> 00:00:02.000',
        'Line one',
        'Line two',
        '',
      ].join('\\n');
      const cues = parseVttFile(new TextEncoder().encode(vtt));
      return cues[0]?.payload;
    })()`);
    expect(payload).toBe('Line one\nLine two');
  });

  test('parses cue settings from timing line', async ({ page }) => {
    const settings = await page.evaluate(`(async () => {
      const { parseVttFile } = await import('/dist/index.js');
      const vtt = [
        'WEBVTT',
        '',
        '00:00:00.000 --> 00:00:01.000 align:center line:90%',
        'Positioned cue',
        '',
      ].join('\\n');
      const cues = parseVttFile(new TextEncoder().encode(vtt));
      return cues[0]?.settings;
    })()`);
    expect(settings).toBe('align:center line:90%');
  });

  test('skips NOTE blocks', async ({ page }) => {
    const count = await page.evaluate(`(async () => {
      const { parseVttFile } = await import('/dist/index.js');
      const vtt = [
        'WEBVTT',
        '',
        'NOTE this is a comment',
        'that spans two lines',
        '',
        '00:00:00.000 --> 00:00:01.000',
        'Real cue',
        '',
      ].join('\\n');
      return parseVttFile(new TextEncoder().encode(vtt)).length;
    })()`);
    expect(count).toBe(1);
  });

  test('handles HH:MM:SS.mmm timestamps (hours > 0)', async ({ page }) => {
    const result = await page.evaluate(`(async () => {
      const { parseVttFile } = await import('/dist/index.js');
      const vtt = [
        'WEBVTT',
        '',
        '01:00:00.000 --> 01:00:30.500',
        'Hour-based cue',
        '',
      ].join('\\n');
      const cues = parseVttFile(new TextEncoder().encode(vtt));
      return { start: cues[0]?.startTime, end: cues[0]?.endTime };
    })()`);
    expect((result as any).start).toBeCloseTo(3600.0, 3);
    expect((result as any).end).toBeCloseTo(3630.5, 3);
  });

  test('strips BOM if present', async ({ page }) => {
    const count = await page.evaluate(`(async () => {
      const { parseVttFile } = await import('/dist/index.js');
      const withBom = '\\uFEFFWEBVTT\\n\\n00:00:00.000 --> 00:00:01.000\\nBOM cue\\n';
      return parseVttFile(new TextEncoder().encode(withBom)).length;
    })()`);
    expect(count).toBe(1);
  });

  test('end-to-end: sidecar VTT through TextSourceBuffer injects VTTCues', async ({ page }) => {
    const result = await page.evaluate(`(async () => {
      const { TextSourceBuffer } = await import('/dist/index.js');
      const video = document.createElement('video');
      document.body.appendChild(video);
      const tsb = new TextSourceBuffer(video, 'Subs', 'en', 'text/vtt');
      tsb.show();
      const vtt = [
        'WEBVTT',
        '',
        '00:00:05.000 --> 00:00:07.500',
        'Sidecar subtitle',
        '',
      ].join('\\n');
      await tsb.append(new TextEncoder().encode(vtt));
      const cues = tsb.textTrack.cues;
      return cues && cues.length > 0
        ? { text: cues[0].text, start: cues[0].startTime, end: cues[0].endTime }
        : null;
    })()`);
    expect(result).not.toBeNull();
    expect((result as any).text).toBe('Sidecar subtitle');
    expect((result as any).start).toBeCloseTo(5.0, 3);
    expect((result as any).end).toBeCloseTo(7.5, 3);
  });

  test('sidecar VTT: timestampOffset is applied to absolute cue times', async ({ page }) => {
    const result = await page.evaluate(`(async () => {
      const { TextSourceBuffer } = await import('/dist/index.js');
      const video = document.createElement('video');
      document.body.appendChild(video);
      const tsb = new TextSourceBuffer(video, 'Subs', 'en', 'text/vtt');
      tsb.timestampOffset = 60; // shift everything by 60s
      tsb.show();
      const vtt = 'WEBVTT\\n\\n00:00:05.000 --> 00:00:06.000\\nShifted cue\\n';
      await tsb.append(new TextEncoder().encode(vtt));
      const cues = tsb.textTrack.cues;
      return cues && cues.length > 0
        ? { start: cues[0].startTime, end: cues[0].endTime }
        : null;
    })()`);
    expect((result as any).start).toBeCloseTo(65.0, 3);
    expect((result as any).end).toBeCloseTo(66.0, 3);
  });
});

test.describe('classifyTextMimeAndCodecs — sidecar MIME types', () => {

  test('text/vtt → vtt-sidecar', async ({ page }) => {
    const kind = await page.evaluate(`(async () => {
      const { classifyTextMimeAndCodecs } = await import('/dist/index.js');
      return classifyTextMimeAndCodecs('text/vtt').kind;
    })()`);
    expect(kind).toBe('vtt-sidecar');
  });

  test('text/vtt; charset=utf-8 → vtt-sidecar', async ({ page }) => {
    const kind = await page.evaluate(`(async () => {
      const { classifyTextMimeAndCodecs } = await import('/dist/index.js');
      return classifyTextMimeAndCodecs('text/vtt; charset=utf-8').kind;
    })()`);
    expect(kind).toBe('vtt-sidecar');
  });

  test('application/ttml+xml → ttml-sidecar', async ({ page }) => {
    const kind = await page.evaluate(`(async () => {
      const { classifyTextMimeAndCodecs } = await import('/dist/index.js');
      return classifyTextMimeAndCodecs('application/ttml+xml').kind;
    })()`);
    expect(kind).toBe('ttml-sidecar');
  });

  test('application/ttml+xml; charset=utf-8 → ttml-sidecar', async ({ page }) => {
    const kind = await page.evaluate(`(async () => {
      const { classifyTextMimeAndCodecs } = await import('/dist/index.js');
      return classifyTextMimeAndCodecs('application/ttml+xml; charset=utf-8').kind;
    })()`);
    expect(kind).toBe('ttml-sidecar');
  });

  test('sidecar TTML through TextSourceBuffer injects VTTCues', async ({ page }) => {
    const result = await page.evaluate(`(async () => {
      const { TextSourceBuffer } = await import('/dist/index.js');
      const video = document.createElement('video');
      document.body.appendChild(video);
      const tsb = new TextSourceBuffer(video, 'Subs', 'en', 'application/ttml+xml');
      tsb.show();
      const ttml = \`<?xml version="1.0"?>
        <tt xml:lang="en" xmlns="http://www.w3.org/ns/ttml">
          <body><div>
            <p begin="00:00:10.000" end="00:00:12.000">TTML sidecar cue</p>
          </div></body>
        </tt>\`;
      await tsb.append(new TextEncoder().encode(ttml));
      const cues = tsb.textTrack.cues;
      return cues && cues.length > 0
        ? { text: cues[0].text, start: cues[0].startTime, end: cues[0].endTime }
        : null;
    })()`);
    expect(result).not.toBeNull();
    expect((result as any).text).toBe('TTML sidecar cue');
    expect((result as any).start).toBeCloseTo(10.0, 3);
    expect((result as any).end).toBeCloseTo(12.0, 3);
  });
});
