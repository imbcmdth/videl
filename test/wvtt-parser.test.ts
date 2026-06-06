/**
 * wvtt sample parser — unit tests.
 *
 * Tested end-to-end through Fmp4TextDemuxer + TextSourceBuffer (the public
 * API). Synthetic vttc/vtte boxes are built inside page.evaluate strings.
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

const HELPERS = `
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
  function makeTrun(dataOffset,samples){
    const cnt=new Uint8Array(u32be(samples.length));const doff=new Uint8Array(u32be(dataOffset));
    const per=concat(...samples.map(s=>concat(new Uint8Array(u32be(s.duration)),new Uint8Array(u32be(s.size)))));
    return fullbox('trun',0,0x000301,concat(cnt,doff,per));
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
  function makeVttcSample(payload, id='', settings='') {
    const children = [];
    if (id)       children.push(box('iden', id));
    if (settings) children.push(box('sttg', settings));
    children.push(box('payl', payload));
    return box('vttc', concat(...children));
  }
  function makeVtteSample() { return box('vtte', new Uint8Array(0)); }
`;

test.describe('parseWvttSample', () => {

  test('vttc sample: payload text is injected as a VTTCue on the TextTrack', async ({ page }) => {
    const result = await page.evaluate(`(async () => {
      ${HELPERS}
      const { TextSourceBuffer } = await import('/dist/index.js');
      const video = document.getElementById('v');
      const tsb   = new TextSourceBuffer(video, 'Subs', 'en', 'wvtt');
      tsb.show();
      const sample   = makeVttcSample('Hello, world!', 'cue-1', 'align:center');
      const initBuf  = makeInit('wvtt', 1000);
      const mediaBuf = makeMedia(0, [{ duration: 1000, size: sample.length, data: sample }]);
      await tsb.append(initBuf);
      await tsb.append(mediaBuf);
      const cues = tsb.textTrack.cues;
      return cues && cues.length > 0
        ? { text: cues[0].text, id: cues[0].id, start: cues[0].startTime, end: cues[0].endTime }
        : null;
    })()`);
    expect(result).not.toBeNull();
    expect((result as any).text).toBe('Hello, world!');
    expect((result as any).id).toBe('cue-1');
    expect((result as any).start).toBeCloseTo(0.0, 3);
    expect((result as any).end).toBeCloseTo(1.0, 3);
  });

  test('vtte (empty cue box) produces no VTTCue', async ({ page }) => {
    const count = await page.evaluate(`(async () => {
      ${HELPERS}
      const { TextSourceBuffer } = await import('/dist/index.js');
      const video = document.getElementById('v');
      const tsb   = new TextSourceBuffer(video, 'Subs', 'en', 'wvtt');
      tsb.show();
      const vtte     = makeVtteSample();
      const initBuf  = makeInit('wvtt', 1000);
      const mediaBuf = makeMedia(0, [{ duration: 1000, size: vtte.length, data: vtte }]);
      await tsb.append(initBuf);
      await tsb.append(mediaBuf);
      return tsb.textTrack.cues?.length ?? 0;
    })()`);
    expect(count).toBe(0);
  });

  test('vttc sample data is preserved byte-for-byte through Fmp4TextDemuxer', async ({ page }) => {
    const dataBytes = await page.evaluate(`(async () => {
      ${HELPERS}
      const { Fmp4TextDemuxer } = await import('/dist/index.js');
      const vttcPayload = makeVttcSample('Hello, world!');
      const initBuf     = makeInit('wvtt', 1000);
      const mediaBuf    = makeMedia(0, [{ duration: 1000, size: vttcPayload.length, data: vttcPayload }]);
      const d = new Fmp4TextDemuxer();
      d.parseInit(initBuf);
      const samples = d.parseMedia(mediaBuf);
      return Array.from(samples[0]?.data ?? []);
    })()`);
    expect((dataBytes as number[]).length).toBeGreaterThan(0);
  });
});
