/**
 * TextSourceBuffer — unit tests.
 *
 * Covers: show/hide, append wvtt/stpp, remove, replace-on-append, abort,
 * changeType (the ADS-switch bug), updating flag, buffered ranges, ftyp+moov
 * init detection, and end-to-end ADS-switch wiring through VidelAdaptationSet.
 *
 * page.evaluate calls use the string overload so TypeScript does not attempt
 * to type-check identifiers that only exist inside the eval'd helpers at runtime.
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

// ---------------------------------------------------------------------------
// Shared segment builders + cue helpers injected into every evaluate.
// ---------------------------------------------------------------------------
const BUILDERS = `
  const enc = new TextEncoder();
  function u32be(v) { return [(v>>>24)&0xff,(v>>>16)&0xff,(v>>>8)&0xff,v&0xff]; }
  function concat(...arrs) { const t=arrs.reduce((s,a)=>s+a.length,0);const r=new Uint8Array(t);let off=0;for(const a of arrs){r.set(a,off);off+=a.length;}return r; }
  function box(fourcc,data){ const d=typeof data==='string'?enc.encode(data):data; const s=8+d.length; return concat(new Uint8Array(u32be(s)),new Uint8Array([...fourcc].map(c=>c.charCodeAt(0))),d); }
  function fullbox(fourcc,version,flags,data){const fb=new Uint8Array(4);fb[0]=version;fb[1]=(flags>>>16)&0xff;fb[2]=(flags>>>8)&0xff;fb[3]=flags&0xff;return box(fourcc,concat(fb,data));}
  function makeMdhd(ts){const d=new Uint8Array(20);new DataView(d.buffer).setUint32(8,ts,false);return fullbox('mdhd',0,0,d);}
  function makeStsd(codec){const e=new Uint8Array(8);return fullbox('stsd',0,0,concat(new Uint8Array(u32be(1)),box(codec,e)));}
  function makeInit(codec,ts){return box('moov',box('trak',box('mdia',concat(makeMdhd(ts),box('minf',box('stbl',makeStsd(codec))))))).buffer;}
  function makeTfhd(){return fullbox('tfhd',0,0,new Uint8Array(u32be(1)));}
  function makeTfdt(bdt){return fullbox('tfdt',0,0,new Uint8Array(u32be(bdt)));}
  function makeTrun(doff,samples){
    const cnt=new Uint8Array(u32be(samples.length));const d=new Uint8Array(u32be(doff));
    const per=concat(...samples.map(s=>concat(new Uint8Array(u32be(s.duration)),new Uint8Array(u32be(s.size)))));
    return fullbox('trun',0,0x000301,concat(cnt,d,per));
  }
  function makeMedia(bdt,samples){
    const tfhd=makeTfhd();const tfdt=makeTfdt(bdt);
    const trunP=makeTrun(0,samples);const trafP=box('traf',concat(tfhd,tfdt,trunP));
    const mfhd=fullbox('mfhd',0,0,new Uint8Array(u32be(1)));
    const moofP=box('moof',concat(mfhd,trafP));const ms=moofP.length;
    const trun=makeTrun(ms+8,samples);const traf=box('traf',concat(tfhd,tfdt,trun));
    const moof=box('moof',concat(mfhd,traf));
    return concat(moof,box('mdat',concat(...samples.map(s=>s.data)))).buffer;
  }
  function makeVttcSample(payload, id, settings) {
    const children = [];
    if (id)       children.push(box('iden', id));
    if (settings) children.push(box('sttg', settings));
    children.push(box('payl', payload));
    return box('vttc', concat(...children));
  }
  function makeVtteSample() { return box('vtte', new Uint8Array(0)); }
  async function appendWvttCue(tsb, payload, pts, duration, timescale) {
    pts = pts || 0; duration = duration || 1000; timescale = timescale || 1000;
    const s = makeVttcSample(payload || 'Test');
    await tsb.append(makeInit('wvtt', timescale));
    await tsb.append(makeMedia(pts, [{ duration, size: s.length, data: s }]));
  }
  async function appendStppCue(tsb, ttml, pts, duration, timescale) {
    pts = pts || 0; duration = duration || 1000; timescale = timescale || 1000;
    const payload = enc.encode(ttml);
    await tsb.append(makeInit('stpp', timescale));
    await tsb.append(makeMedia(pts, [{ duration, size: payload.length, data: payload }]));
  }
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('TextSourceBuffer', () => {

  test('constructor creates TextTrack in hidden mode', async ({ page }) => {
    const mode = await page.evaluate(`(async () => {
      const { TextSourceBuffer } = await import('/dist/index.js');
      const video = document.getElementById('v');
      const tsb   = new TextSourceBuffer(video, 'Subs', 'en', 'wvtt');
      return tsb.textTrack.mode;
    })()`);
    expect(mode).toBe('hidden');
  });

  test('show() sets textTrack.mode to showing', async ({ page }) => {
    const mode = await page.evaluate(`(async () => {
      const { TextSourceBuffer } = await import('/dist/index.js');
      const video = document.getElementById('v');
      const tsb   = new TextSourceBuffer(video, 'Subs', 'en', 'wvtt');
      tsb.show();
      return tsb.textTrack.mode;
    })()`);
    expect(mode).toBe('showing');
  });

  test('hide() sets textTrack.mode to hidden after show', async ({ page }) => {
    const mode = await page.evaluate(`(async () => {
      const { TextSourceBuffer } = await import('/dist/index.js');
      const video = document.getElementById('v');
      const tsb   = new TextSourceBuffer(video, 'Subs', 'en', 'wvtt');
      tsb.show();
      tsb.hide();
      return tsb.textTrack.mode;
    })()`);
    expect(mode).toBe('hidden');
  });

  test('appending only an init segment does not update buffered range', async ({ page }) => {
    const length = await page.evaluate(`(async () => {
      ${BUILDERS}
      const { TextSourceBuffer } = await import('/dist/index.js');
      const video = document.getElementById('v');
      const tsb   = new TextSourceBuffer(video, 'Subs', 'en', 'wvtt');
      await tsb.append(makeInit('wvtt', 1000));
      return tsb.buffered.length;
    })()`);
    expect(length).toBe(0);
  });

  test('append wvtt media segment injects a VTTCue with correct timing', async ({ page }) => {
    const result = await page.evaluate(`(async () => {
      ${BUILDERS}
      const { TextSourceBuffer } = await import('/dist/index.js');
      const video = document.getElementById('v');
      const tsb   = new TextSourceBuffer(video, 'Subs', 'en', 'wvtt');
      tsb.show();
      await appendWvttCue(tsb, 'Hello!', 0, 1000, 1000);
      const cues = tsb.textTrack.cues;
      return cues && cues.length > 0
        ? { count: cues.length, text: cues[0].text, start: cues[0].startTime, end: cues[0].endTime }
        : null;
    })()`);
    expect(result).not.toBeNull();
    expect((result as any).count).toBe(1);
    expect((result as any).text).toBe('Hello!');
    expect((result as any).start).toBeCloseTo(0.0, 3);
    expect((result as any).end).toBeCloseTo(1.0, 3);
  });

  test('append wvtt updates buffered range with correct seconds', async ({ page }) => {
    const buffered = await page.evaluate(`(async () => {
      ${BUILDERS}
      const { TextSourceBuffer } = await import('/dist/index.js');
      const video = document.getElementById('v');
      const tsb   = new TextSourceBuffer(video, 'Subs', 'en', 'wvtt');
      // pts=2000 ticks / timescale=1000 → 2.0s; duration=1000 ticks → 1.0s
      await appendWvttCue(tsb, 'Cue', 2000, 1000, 1000);
      return { length: tsb.buffered.length, start: tsb.buffered.start(0), end: tsb.buffered.end(0) };
    })()`);
    expect((buffered as any).length).toBe(1);
    expect((buffered as any).start).toBeCloseTo(2.0, 3);
    expect((buffered as any).end).toBeCloseTo(3.0, 3);
  });

  test('remove() deletes cues in range and trims buffered', async ({ page }) => {
    const result = await page.evaluate(`(async () => {
      ${BUILDERS}
      const { TextSourceBuffer } = await import('/dist/index.js');
      const video = document.getElementById('v');
      const tsb   = new TextSourceBuffer(video, 'Subs', 'en', 'wvtt');
      const s1 = makeVttcSample('First');
      const s2 = makeVttcSample('Second');
      await tsb.append(makeInit('wvtt', 1000));
      await tsb.append(makeMedia(0, [
        { duration: 1000, size: s1.length, data: s1 },
        { duration: 1000, size: s2.length, data: s2 },
      ]));
      const beforeCount = tsb.textTrack.cues?.length ?? 0;
      await tsb.remove(0, 1);
      const afterCount  = tsb.textTrack.cues?.length ?? 0;
      const bufferedEnd = tsb.buffered.length > 0 ? tsb.buffered.end(tsb.buffered.length - 1) : 0;
      return { beforeCount, afterCount, bufferedEnd };
    })()`);
    expect((result as any).beforeCount).toBe(2);
    expect((result as any).afterCount).toBe(1);
    expect((result as any).bufferedEnd).toBeCloseTo(2.0, 3);
  });

  test('replace-on-append: appending same range replaces old cues', async ({ page }) => {
    const result = await page.evaluate(`(async () => {
      ${BUILDERS}
      const { TextSourceBuffer } = await import('/dist/index.js');
      const video = document.getElementById('v');
      const tsb   = new TextSourceBuffer(video, 'Subs', 'en', 'wvtt');
      tsb.show();
      await appendWvttCue(tsb, 'Old cue', 0, 1000, 1000);
      const beforeText = tsb.textTrack.cues?.[0]?.text;
      // Re-append at the same range — old cue should be replaced
      const s = makeVttcSample('New cue');
      await tsb.append(makeMedia(0, [{ duration: 1000, size: s.length, data: s }]));
      const afterCount = tsb.textTrack.cues?.length ?? 0;
      const afterText  = tsb.textTrack.cues?.[0]?.text;
      return { beforeText, afterCount, afterText };
    })()`);
    expect((result as any).beforeText).toBe('Old cue');
    expect((result as any).afterCount).toBe(1);
    expect((result as any).afterText).toBe('New cue');
  });

  test('timestampOffset shifts cue start and end times', async ({ page }) => {
    const result = await page.evaluate(`(async () => {
      ${BUILDERS}
      const { TextSourceBuffer } = await import('/dist/index.js');
      const video = document.getElementById('v');
      const tsb   = new TextSourceBuffer(video, 'Subs', 'en', 'wvtt');
      tsb.timestampOffset = 100;
      tsb.show();
      // sample at pts=0, duration=1s → cue at [100, 101]
      await appendWvttCue(tsb, 'Cue', 0, 1000, 1000);
      const cues = tsb.textTrack.cues;
      return cues && cues.length > 0 ? { start: cues[0].startTime, end: cues[0].endTime } : null;
    })()`);
    expect(result).not.toBeNull();
    expect((result as any).start).toBeCloseTo(100.0, 3);
    expect((result as any).end).toBeCloseTo(101.0, 3);
  });

  test('abort() rejects queued operations', async ({ page }) => {
    const result = await page.evaluate(`(async () => {
      ${BUILDERS}
      const { TextSourceBuffer } = await import('/dist/index.js');
      const video = document.getElementById('v');
      const tsb   = new TextSourceBuffer(video, 'Subs', 'en', 'wvtt');
      const out = [];
      const initBuf = makeInit('wvtt', 1000);
      tsb.append(initBuf).then(() => out.push('p1-resolved')).catch(() => out.push('p1-rejected'));
      tsb.append(initBuf).then(() => out.push('p2-resolved')).catch(() => out.push('p2-rejected'));
      await tsb.abort();
      out.push('abort-done');
      await new Promise(r => setTimeout(r, 20));
      return out;
    })()`);
    expect(result as string[]).toContain('abort-done');
    expect(result as string[]).toContain('p2-rejected');
    expect(result as string[]).not.toContain('p2-resolved');
  });

  test('changeType() updates codec so new codec samples parse correctly', async ({ page }) => {
    const result = await page.evaluate(`(async () => {
      ${BUILDERS}
      const { TextSourceBuffer } = await import('/dist/index.js');
      const video = document.getElementById('v');
      const tsb   = new TextSourceBuffer(video, 'Subs', 'en', 'wvtt');
      tsb.show();
      await appendWvttCue(tsb, 'VTT cue', 0, 1000, 1000);
      const countAfterWvtt = tsb.textTrack.cues?.length ?? 0;
      // Switch to stpp — without this changeType the demuxer + codec class
      // would still be wvtt and the stpp samples would be mis-routed.
      tsb.changeType('application/mp4; codecs="stpp"');
      const ttml = \`<?xml version="1.0"?>
        <tt xml:lang="en" xmlns="http://www.w3.org/ns/ttml">
          <body><div>
            <p begin="00:00:01.000" end="00:00:02.000">TTML cue</p>
          </div></body>
        </tt>\`;
      await appendStppCue(tsb, ttml, 0, 2000, 1000);
      const stppTexts = Array.from(tsb.textTrack.cues ?? []).map(c => c.text);
      return { countAfterWvtt, stppTexts };
    })()`);
    expect((result as any).countAfterWvtt).toBe(1);
    expect((result as any).stppTexts).toContain('TTML cue');
  });

  test('image-profile codec: appends are silently discarded with no cues', async ({ page }) => {
    const count = await page.evaluate(`(async () => {
      ${BUILDERS}
      const { TextSourceBuffer } = await import('/dist/index.js');
      const video = document.getElementById('v');
      const tsb   = new TextSourceBuffer(video, 'Subs', 'en', 'stpp.ttml.im1i');
      tsb.show();
      const payload  = enc.encode('<tt/>');
      await tsb.append(makeInit('stpp', 1000));
      await tsb.append(makeMedia(0, [{ duration: 1000, size: payload.length, data: payload }]));
      return tsb.textTrack.cues?.length ?? 0;
    })()`);
    expect(count).toBe(0);
  });

  test('vtte (empty cue box) produces no cue on TextTrack', async ({ page }) => {
    const count = await page.evaluate(`(async () => {
      ${BUILDERS}
      const { TextSourceBuffer } = await import('/dist/index.js');
      const video = document.getElementById('v');
      const tsb   = new TextSourceBuffer(video, 'Subs', 'en', 'wvtt');
      tsb.show();
      const vtte = makeVtteSample();
      await tsb.append(makeInit('wvtt', 1000));
      await tsb.append(makeMedia(0, [{ duration: 1000, size: vtte.length, data: vtte }]));
      return tsb.textTrack.cues?.length ?? 0;
    })()`);
    expect(count).toBe(0);
  });

  test('updating is true while append is in flight, false after', async ({ page }) => {
    const result = await page.evaluate(`(async () => {
      ${BUILDERS}
      const { TextSourceBuffer } = await import('/dist/index.js');
      const video = document.getElementById('v');
      const tsb   = new TextSourceBuffer(video, 'Subs', 'en', 'wvtt');
      const p = tsb.append(makeInit('wvtt', 1000));
      const updatingDuring = tsb.updating;
      await p;
      return { updatingDuring, updatingAfter: tsb.updating };
    })()`);
    expect((result as any).updatingDuring).toBe(true);
    expect((result as any).updatingAfter).toBe(false);
  });

  test('ftyp + moov init: cue times are in seconds, not raw ticks (bug regression)', async ({ page }) => {
    // Root cause: the old check `fourcc[4..7] === 'moov'` failed when ftyp
    // preceded moov. The demuxer timescale stayed at 1, producing startTime=24000
    // instead of 24.0s (at timescale=1000).
    const result = await page.evaluate(`(async () => {
      ${BUILDERS}
      const { TextSourceBuffer } = await import('/dist/index.js');
      const video = document.getElementById('v');
      const tsb   = new TextSourceBuffer(video, 'Subs', 'en', 'wvtt');
      tsb.show();
      const timescale = 1000;
      const ptsTicks  = 24000; // 24 seconds
      const durTicks  = 2000;  //  2 seconds
      // Build init with ftyp BEFORE moov
      const ftypData = new Uint8Array(12);
      ftypData.set([0x69,0x73,0x6f,0x6d], 0); // 'isom'
      const ftypBox    = box('ftyp', ftypData);
      const moovBytes  = new Uint8Array(makeInit('wvtt', timescale));
      const initBuf    = concat(ftypBox, moovBytes).buffer;
      const sample     = makeVttcSample('Subtitle at 24s');
      const mediaBuf   = makeMedia(ptsTicks, [{ duration: durTicks, size: sample.length, data: sample }]);
      await tsb.append(initBuf);
      await tsb.append(mediaBuf);
      const cues = tsb.textTrack.cues;
      return cues && cues.length > 0
        ? { start: cues[0].startTime, end: cues[0].endTime }
        : null;
    })()`);
    expect(result).not.toBeNull();
    expect((result as any).start).toBeCloseTo(24.0, 2);
    expect((result as any).end).toBeCloseTo(26.0, 2);
  });
});

// ---------------------------------------------------------------------------
// Integration: ADS switch calls changeType on the TextSourceBuffer
// ---------------------------------------------------------------------------

test.describe('TextSourceBuffer — ADS switch wires changeType (bug regression)', () => {

  test('activating a real text ADS calls changeType with its codec', async ({ page }) => {
    const calls = await page.evaluate(`(async () => {
      const { TextSourceBuffer } = await import('/dist/index.js');
      const video = document.getElementById('v');
      const changeTypeCalls = [];
      const tsb = new TextSourceBuffer(video, 'Subs', 'en', 'wvtt');
      const orig = tsb.changeType.bind(tsb);
      tsb.changeType = m => { changeTypeCalls.push(m); orig(m); };
      const ads = document.createElement('videl-adaptation-set');
      ads.setAttribute('content-type', 'text');
      ads.setAttribute('mime-type',    'application/mp4');
      ads.setAttribute('codecs',       'stpp.ttml.im1t');
      document.body.appendChild(ads);
      ads.sourceBuffer = tsb;
      ads.setAttribute('videl-state', 'active');
      await new Promise(r => setTimeout(r, 30));
      return changeTypeCalls;
    })()`);
    expect((calls as string[]).length).toBeGreaterThan(0);
    expect((calls as string[]).some((s: string) => s.includes('stpp.ttml.im1t'))).toBe(true);
  });

  test('activating the None ADS calls hide() and NOT changeType()', async ({ page }) => {
    const result = await page.evaluate(`(async () => {
      const { TextSourceBuffer } = await import('/dist/index.js');
      const video = document.getElementById('v');
      const changeTypeCalls = [];
      let hideCalled = false;
      const tsb = new TextSourceBuffer(video, 'Subs', 'en', 'wvtt');
      const origCT = tsb.changeType.bind(tsb);
      tsb.changeType = m => { changeTypeCalls.push(m); origCT(m); };
      const origHide = tsb.hide.bind(tsb);
      tsb.hide = () => { hideCalled = true; origHide(); };
      const ads = document.createElement('videl-adaptation-set');
      ads.setAttribute('content-type',   'text');
      ads.setAttribute('videl-text-none', '');
      ads.setAttribute('label',          'None');
      document.body.appendChild(ads);
      ads.sourceBuffer = tsb;
      ads.setAttribute('videl-state', 'active');
      await new Promise(r => setTimeout(r, 30));
      return { changeTypeCalls, hideCalled };
    })()`);
    expect((result as any).changeTypeCalls.length).toBe(0);
    expect((result as any).hideCalled).toBe(true);
  });

  test('switching between two text ADSs updates codec on the shared TextSourceBuffer', async ({ page }) => {
    const codecsSeen = await page.evaluate(`(async () => {
      const { TextSourceBuffer } = await import('/dist/index.js');
      const video = document.getElementById('v');
      const codecsSeen = [];
      const tsb = new TextSourceBuffer(video, 'Subs', 'en', 'wvtt');
      const orig = tsb.changeType.bind(tsb);
      tsb.changeType = m => { codecsSeen.push(m); orig(m); };
      const period = document.createElement('videl-period');
      period.setAttribute('period-id', 'p0');
      period.setAttribute('start', '0');
      document.body.appendChild(period);
      const noneAds = document.createElement('videl-adaptation-set');
      noneAds.setAttribute('content-type',   'text');
      noneAds.setAttribute('videl-text-none', '');
      noneAds.setAttribute('label',          'None');
      period.appendChild(noneAds);
      noneAds.sourceBuffer = tsb;
      const enAds = document.createElement('videl-adaptation-set');
      enAds.setAttribute('content-type', 'text');
      enAds.setAttribute('mime-type',    'application/mp4');
      enAds.setAttribute('codecs',       'wvtt');
      enAds.setAttribute('label',        'English');
      period.appendChild(enAds);
      enAds.sourceBuffer = tsb;
      const frAds = document.createElement('videl-adaptation-set');
      frAds.setAttribute('content-type', 'text');
      frAds.setAttribute('mime-type',    'application/mp4');
      frAds.setAttribute('codecs',       'stpp.ttml.im1t');
      frAds.setAttribute('label',        'French');
      period.appendChild(frAds);
      frAds.sourceBuffer = tsb;
      // Activate period — None ADS becomes active first
      period.setAttribute('videl-state', 'active');
      await new Promise(r => setTimeout(r, 30));
      // Switch to English
      enAds.dispatchEvent(new CustomEvent('videl:track:select', {
        bubbles: true, composed: true, detail: { ads: enAds }
      }));
      await new Promise(r => setTimeout(r, 30));
      // Switch to French
      frAds.dispatchEvent(new CustomEvent('videl:track:select', {
        bubbles: true, composed: true, detail: { ads: frAds }
      }));
      await new Promise(r => setTimeout(r, 30));
      return codecsSeen;
    })()`);
    expect((codecsSeen as string[]).some((s: string) => s.includes('wvtt'))).toBe(true);
    expect((codecsSeen as string[]).some((s: string) => s.includes('stpp.ttml.im1t'))).toBe(true);
  });
});
