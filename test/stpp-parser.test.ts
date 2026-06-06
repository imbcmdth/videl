/**
 * stpp (TTML) sample parser — unit tests via TextSourceBuffer.
 *
 * page.evaluate calls use the string overload so TypeScript does not attempt
 * to resolve identifiers defined inside the inline segment-builder helpers.
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
    route.fulfill({
      contentType: 'text/html',
      body: `<!DOCTYPE html><html><body><video id="v" muted playsinline></video></body></html>`,
    })
  );
  await page.goto('http://localhost:3000/');
});

// Segment builders + appendTextSegment helper injected into every evaluate.
const HELPERS = `
  const enc2 = new TextEncoder();
  function u32be2(v) { return [(v>>>24)&0xff,(v>>>16)&0xff,(v>>>8)&0xff,v&0xff]; }
  function concat2(...arrs) { const t=arrs.reduce((s,a)=>s+a.length,0);const r=new Uint8Array(t);let off=0;for(const a of arrs){r.set(a,off);off+=a.length;}return r; }
  function box2(fourcc,data){ const s=8+data.length; return concat2(new Uint8Array(u32be2(s)),new Uint8Array([...fourcc].map(c=>c.charCodeAt(0))),data); }
  function fullbox2(fourcc,version,flags,data){const fb=new Uint8Array(4);fb[0]=version;fb[1]=(flags>>>16)&0xff;fb[2]=(flags>>>8)&0xff;fb[3]=flags&0xff;return box2(fourcc,concat2(fb,data));}
  function makeMdhd2(ts){const d=new Uint8Array(20);new DataView(d.buffer).setUint32(8,ts,false);return fullbox2('mdhd',0,0,d);}
  function makeStsd2(codec){const e=new Uint8Array(8);return fullbox2('stsd',0,0,concat2(new Uint8Array(u32be2(1)),box2(codec,e)));}
  function makeInit2(codec,ts){return box2('moov',box2('trak',box2('mdia',concat2(makeMdhd2(ts),box2('minf',box2('stbl',makeStsd2(codec))))))).buffer;}
  function makeTfhd2(){return fullbox2('tfhd',0,0,new Uint8Array(u32be2(1)));}
  function makeTfdt2(bdt){return fullbox2('tfdt',0,0,new Uint8Array(u32be2(bdt)));}
  function makeTrun2(doff,samples){
    const cnt=new Uint8Array(u32be2(samples.length));const d=new Uint8Array(u32be2(doff));
    const per=concat2(...samples.map(s=>concat2(new Uint8Array(u32be2(s.duration)),new Uint8Array(u32be2(s.size)))));
    return fullbox2('trun',0,0x000301,concat2(cnt,d,per));
  }
  function makeMedia2(bdt,samples){
    const tfhd=makeTfhd2();const tfdt=makeTfdt2(bdt);
    const trunP=makeTrun2(0,samples);const trafP=box2('traf',concat2(tfhd,tfdt,trunP));
    const mfhd=fullbox2('mfhd',0,0,new Uint8Array(u32be2(1)));
    const moofP=box2('moof',concat2(mfhd,trafP));const ms=moofP.length;
    const trun=makeTrun2(ms+8,samples);const traf=box2('traf',concat2(tfhd,tfdt,trun));
    const moof=box2('moof',concat2(mfhd,traf));
    return concat2(moof,box2('mdat',concat2(...samples.map(s=>s.data)))).buffer;
  }
  async function appendTtml(tsb, ttml, bdt, duration, timescale) {
    const payload = enc2.encode(ttml);
    const initBuf  = makeInit2('stpp', timescale || 1000);
    const mediaBuf = makeMedia2(bdt || 0, [{ duration: duration || 1000, size: payload.length, data: payload }]);
    await tsb.append(initBuf);
    await tsb.append(mediaBuf);
  }
`;

test.describe('stpp sample parser (via TextSourceBuffer)', () => {

  test('parses a basic TTML <p> element into a VTTCue', async ({ page }) => {
    const result = await page.evaluate(`(async () => {
      ${HELPERS}
      const { TextSourceBuffer } = await import('/dist/index.js');
      const video = document.getElementById('v');
      const tsb   = new TextSourceBuffer(video, 'Test', 'en', 'stpp');
      tsb.show();
      const ttml = \`<?xml version="1.0"?>
        <tt xml:lang="en" xmlns="http://www.w3.org/ns/ttml">
          <body><div>
            <p begin="00:00:00.000" end="00:00:01.500">Hello world</p>
          </div></body>
        </tt>\`;
      await appendTtml(tsb, ttml);
      const cues = tsb.textTrack.cues;
      return cues && cues.length > 0
        ? { text: cues[0].text, start: cues[0].startTime, end: cues[0].endTime }
        : null;
    })()`);
    expect(result).not.toBeNull();
    expect((result as any).text).toBe('Hello world');
    expect((result as any).start).toBeCloseTo(0.0, 3);
    expect((result as any).end).toBeCloseTo(1.5, 3);
  });

  test('parses multiple <p> elements into separate cues', async ({ page }) => {
    const count = await page.evaluate(`(async () => {
      ${HELPERS}
      const { TextSourceBuffer } = await import('/dist/index.js');
      const video = document.getElementById('v');
      const tsb   = new TextSourceBuffer(video, 'Test', 'en', 'stpp');
      tsb.show();
      const ttml = \`<?xml version="1.0"?>
        <tt xml:lang="en" xmlns="http://www.w3.org/ns/ttml">
          <body><div>
            <p begin="00:00:00.000" end="00:00:01.000">First</p>
            <p begin="00:00:01.000" end="00:00:02.000">Second</p>
            <p begin="00:00:02.000" end="00:00:03.000">Third</p>
          </div></body>
        </tt>\`;
      await appendTtml(tsb, ttml, 0, 3000);
      return tsb.textTrack.cues?.length ?? 0;
    })()`);
    expect(count).toBe(3);
  });

  test('TTML timing is relative to sample PTS plus timestampOffset', async ({ page }) => {
    const result = await page.evaluate(`(async () => {
      ${HELPERS}
      const { TextSourceBuffer } = await import('/dist/index.js');
      const video = document.getElementById('v');
      const tsb = new TextSourceBuffer(video, 'Test', 'en', 'stpp');
      tsb.timestampOffset = 10;
      tsb.show();
      // PTS = 5000 / 1000 = 5s; timestampOffset = 10s
      // TTML begin=0.5s → cue.startTime = 5 + 10 + 0.5 = 15.5
      // TTML end=1.0s   → cue.endTime   = 5 + 10 + 1.0 = 16.0
      const ttml = \`<?xml version="1.0"?>
        <tt xml:lang="en" xmlns="http://www.w3.org/ns/ttml">
          <body><div>
            <p begin="00:00:00.500" end="00:00:01.000">Offset cue</p>
          </div></body>
        </tt>\`;
      await appendTtml(tsb, ttml, 5000, 1000);
      const cues = tsb.textTrack.cues;
      return cues && cues.length > 0
        ? { start: cues[0].startTime, end: cues[0].endTime }
        : null;
    })()`);
    expect(result).not.toBeNull();
    expect((result as any).start).toBeCloseTo(15.5, 3);
    expect((result as any).end).toBeCloseTo(16.0, 3);
  });

  test('<p> with no begin/end is skipped', async ({ page }) => {
    const count = await page.evaluate(`(async () => {
      ${HELPERS}
      const { TextSourceBuffer } = await import('/dist/index.js');
      const video = document.getElementById('v');
      const tsb   = new TextSourceBuffer(video, 'Test', 'en', 'stpp');
      tsb.show();
      const ttml = \`<?xml version="1.0"?>
        <tt xmlns="http://www.w3.org/ns/ttml">
          <body><div><p>No timing here</p></div></body>
        </tt>\`;
      await appendTtml(tsb, ttml);
      return tsb.textTrack.cues?.length ?? 0;
    })()`);
    expect(count).toBe(0);
  });

  test('malformed XML produces no cues and does not throw', async ({ page }) => {
    const count = await page.evaluate(`(async () => {
      ${HELPERS}
      const { TextSourceBuffer } = await import('/dist/index.js');
      const video = document.getElementById('v');
      const tsb   = new TextSourceBuffer(video, 'Test', 'en', 'stpp');
      tsb.show();
      await appendTtml(tsb, '<not valid xml<<<<');
      return tsb.textTrack.cues?.length ?? 0;
    })()`);
    expect(count).toBe(0);
  });

  test('frame-based timing (HH:MM:SS:ff) is parsed approximately at 30fps', async ({ page }) => {
    const result = await page.evaluate(`(async () => {
      ${HELPERS}
      const { TextSourceBuffer } = await import('/dist/index.js');
      const video = document.getElementById('v');
      const tsb   = new TextSourceBuffer(video, 'Test', 'en', 'stpp');
      tsb.show();
      // 00:00:01:00 = 1.0s; 00:00:02:15 = 2 + 15/30 = 2.5s
      const ttml = \`<?xml version="1.0"?>
        <tt xmlns="http://www.w3.org/ns/ttml">
          <body><div>
            <p begin="00:00:01:00" end="00:00:02:15">Frame timing</p>
          </div></body>
        </tt>\`;
      await appendTtml(tsb, ttml, 0, 3000);
      const cues = tsb.textTrack.cues;
      return cues && cues.length > 0 ? { start: cues[0].startTime, end: cues[0].endTime } : null;
    })()`);
    expect(result).not.toBeNull();
    expect((result as any).start).toBeCloseTo(1.0, 2);
    expect((result as any).end).toBeCloseTo(2.5, 2);
  });
});
