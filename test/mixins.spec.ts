import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const MODULE_PATH = path.join(__dirname, '../dist/index.js');

// ---------------------------------------------------------------------------
// Shared setup: serve the built module and a minimal HTML page.
// ---------------------------------------------------------------------------
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
      body: `<!DOCTYPE html><html><body></body></html>`,
    })
  );
  await page.goto('http://localhost:3000/');
});

// ===========================================================================
// PickOneMixin
// ===========================================================================

test.describe('PickOneMixin', () => {

  test('criterion 1 — activating a second child removes slot=active from the first', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { PickOneMixin } = await import('/dist/index.js');
      class El extends PickOneMixin(HTMLElement) {}
      customElements.define('test-pick-one-c1', El);

      const host = document.createElement('test-pick-one-c1') as any;
      document.body.appendChild(host);
      await customElements.whenDefined('test-pick-one-c1');

      const c1 = document.createElement('div');
      const c2 = document.createElement('div');
      host.appendChild(c1);
      host.appendChild(c2);

      host.activateChild(c1);
      host.activateChild(c2);

      return {
        c1Slot: c1.getAttribute('slot'),
        c2Slot: c2.getAttribute('slot'),
      };
    });

    expect(result.c1Slot).toBeNull();
    expect(result.c2Slot).toBe('active');
  });

  test('criterion 2 — preloading a second child removes slot=next from the first', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { PickOneMixin } = await import('/dist/index.js');
      class El extends PickOneMixin(HTMLElement) {}
      customElements.define('test-pick-one-c2', El);

      const host = document.createElement('test-pick-one-c2') as any;
      document.body.appendChild(host);
      await customElements.whenDefined('test-pick-one-c2');

      const c1 = document.createElement('div');
      const c2 = document.createElement('div');
      host.appendChild(c1);
      host.appendChild(c2);

      host.preloadChild(c1);
      host.preloadChild(c2);

      return {
        c1Slot: c1.getAttribute('slot'),
        c2Slot: c2.getAttribute('slot'),
      };
    });

    expect(result.c1Slot).toBeNull();
    expect(result.c2Slot).toBe('next');
  });

  test('criterion 3 — removing host slot synchronously strips slot from all slotted children', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { PickOneMixin } = await import('/dist/index.js');
      class El extends PickOneMixin(HTMLElement) {}
      customElements.define('test-pick-one-c3', El);

      const host = document.createElement('test-pick-one-c3') as any;
      document.body.appendChild(host);
      await customElements.whenDefined('test-pick-one-c3');

      const active = document.createElement('div');
      const next = document.createElement('div');
      host.appendChild(active);
      host.appendChild(next);

      host.activateChild(active);
      host.preloadChild(next);

      // Give the host a slot so removing it triggers deactivation cascade.
      host.setAttribute('slot', 'active');

      // Remove the host's slot synchronously.
      host.removeAttribute('slot');

      // Check immediately — no await — to verify synchronous deactivation.
      return {
        activeSlot: active.getAttribute('slot'),
        nextSlot: next.getAttribute('slot'),
      };
    });

    expect(result.activeSlot).toBeNull();
    expect(result.nextSlot).toBeNull();
  });

  test('criterion 10 — native slotchange fires on <slot name="active"> and <slot name="next"> on transitions', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { PickOneMixin } = await import('/dist/index.js');
      class El extends PickOneMixin(HTMLElement) {}
      customElements.define('test-pick-one-c10', El);

      const host = document.createElement('test-pick-one-c10') as any;
      document.body.appendChild(host);
      await customElements.whenDefined('test-pick-one-c10');

      const child = document.createElement('div');
      host.appendChild(child);

      const activeSlot = host.shadowRoot!.querySelector('slot[name="active"]');
      const nextSlot = host.shadowRoot!.querySelector('slot[name="next"]');

      if (!activeSlot || !nextSlot) return { error: 'shadow slots missing' };

      let activeChanges = 0;
      let nextChanges = 0;
      activeSlot.addEventListener('slotchange', () => activeChanges++);
      nextSlot.addEventListener('slotchange', () => nextChanges++);

      host.preloadChild(child);
      // Flush microtasks so slotchange fires.
      await new Promise<void>(r => setTimeout(r, 0));
      host.activateChild(child);
      await new Promise<void>(r => setTimeout(r, 0));

      return { activeChanges, nextChanges };
    });

    expect(result.activeChanges).toBeGreaterThanOrEqual(1);
    expect(result.nextChanges).toBeGreaterThanOrEqual(1);
  });

});

// ===========================================================================
// PickNMixin
// ===========================================================================

test.describe('PickNMixin', () => {

  test('criterion 4 — children with different keys can both hold slot=active', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { PickNMixin } = await import('/dist/index.js');
      class El extends PickNMixin(HTMLElement) {
        getSlotKey(child: Element) {
          return child.getAttribute('data-key') ?? 'default';
        }
      }
      customElements.define('test-pick-n-c4', El);

      const host = document.createElement('test-pick-n-c4') as any;
      document.body.appendChild(host);
      await customElements.whenDefined('test-pick-n-c4');

      const video = document.createElement('div');
      video.setAttribute('data-key', 'video');
      const audio = document.createElement('div');
      audio.setAttribute('data-key', 'audio');
      host.appendChild(video);
      host.appendChild(audio);

      host.activateChild(video);
      host.activateChild(audio);

      return {
        videoSlot: video.getAttribute('slot'),
        audioSlot: audio.getAttribute('slot'),
      };
    });

    expect(result.videoSlot).toBe('video-active');
    expect(result.audioSlot).toBe('audio-active');
  });

  test('criterion 5 — same key: newer active assignment wins; older is removed', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { PickNMixin } = await import('/dist/index.js');
      class El extends PickNMixin(HTMLElement) {
        getSlotKey(_child: Element) { return 'video'; }
      }
      customElements.define('test-pick-n-c5', El);

      const host = document.createElement('test-pick-n-c5') as any;
      document.body.appendChild(host);
      await customElements.whenDefined('test-pick-n-c5');

      const c1 = document.createElement('div');
      const c2 = document.createElement('div');
      host.appendChild(c1);
      host.appendChild(c2);

      host.activateChild(c1);
      host.activateChild(c2);

      return {
        c1Slot: c1.getAttribute('slot'),
        c2Slot: c2.getAttribute('slot'),
      };
    });

    expect(result.c1Slot).toBeNull();
    expect(result.c2Slot).toBe('video-active');
  });

  test('criterion 5a — different keys can both hold slot=next simultaneously', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { PickNMixin } = await import('/dist/index.js');
      class El extends PickNMixin(HTMLElement) {
        getSlotKey(child: Element) { return child.getAttribute('data-key') ?? 'default'; }
      }
      customElements.define('test-pick-n-c5a', El);

      const host = document.createElement('test-pick-n-c5a') as any;
      document.body.appendChild(host);
      await customElements.whenDefined('test-pick-n-c5a');

      const v = document.createElement('div'); v.setAttribute('data-key', 'video');
      const a = document.createElement('div'); a.setAttribute('data-key', 'audio');
      host.appendChild(v);
      host.appendChild(a);

      host.preloadChild(v);
      host.preloadChild(a);

      return {
        vSlot: v.getAttribute('slot'),
        aSlot: a.getAttribute('slot'),
      };
    });

    expect(result.vSlot).toBe('video-next');
    expect(result.aSlot).toBe('audio-next');
  });

  test('criterion 5b — same key: newer next assignment wins; older is removed', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { PickNMixin } = await import('/dist/index.js');
      class El extends PickNMixin(HTMLElement) {
        getSlotKey(_child: Element) { return 'audio'; }
      }
      customElements.define('test-pick-n-c5b', El);

      const host = document.createElement('test-pick-n-c5b') as any;
      document.body.appendChild(host);
      await customElements.whenDefined('test-pick-n-c5b');

      const c1 = document.createElement('div');
      const c2 = document.createElement('div');
      host.appendChild(c1);
      host.appendChild(c2);

      host.preloadChild(c1);
      host.preloadChild(c2);

      return {
        c1Slot: c1.getAttribute('slot'),
        c2Slot: c2.getAttribute('slot'),
      };
    });

    expect(result.c1Slot).toBeNull();
    expect(result.c2Slot).toBe('audio-next');
  });

  test('criterion 3 (PickNMixin) — removing host slot synchronously deactivates all children', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { PickNMixin } = await import('/dist/index.js');
      class El extends PickNMixin(HTMLElement) {
        getSlotKey(child: Element) { return child.getAttribute('data-key') ?? 'default'; }
      }
      customElements.define('test-pick-n-c3', El);

      const host = document.createElement('test-pick-n-c3') as any;
      document.body.appendChild(host);
      await customElements.whenDefined('test-pick-n-c3');

      const v = document.createElement('div'); v.setAttribute('data-key', 'video');
      const a = document.createElement('div'); a.setAttribute('data-key', 'audio');
      host.appendChild(v);
      host.appendChild(a);

      host.activateChild(v);
      host.activateChild(a);

      host.setAttribute('slot', 'active');
      host.removeAttribute('slot');

      return {
        vSlot: v.getAttribute('slot'),
        aSlot: a.getAttribute('slot'),
      };
    });

    expect(result.vSlot).toBeNull();
    expect(result.aSlot).toBeNull();
  });

  test('criterion 11 — shadow slots for a key are created lazily', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { PickNMixin } = await import('/dist/index.js');
      class El extends PickNMixin(HTMLElement) {
        getSlotKey(child: Element) { return child.getAttribute('data-key') ?? 'default'; }
      }
      customElements.define('test-pick-n-c11', El);

      const host = document.createElement('test-pick-n-c11') as any;
      document.body.appendChild(host);
      await customElements.whenDefined('test-pick-n-c11');

      // Before any activation, slots should not exist.
      const beforeVideo = !!host.shadowRoot?.querySelector('slot[name="video-active"]');
      const beforeAudio = !!host.shadowRoot?.querySelector('slot[name="audio-active"]');

      const v = document.createElement('div'); v.setAttribute('data-key', 'video');
      host.appendChild(v);
      host.activateChild(v);

      // After activating video, only the video slot should exist.
      const afterVideo = !!host.shadowRoot?.querySelector('slot[name="video-active"]');
      const afterAudio = !!host.shadowRoot?.querySelector('slot[name="audio-active"]');

      return { beforeVideo, beforeAudio, afterVideo, afterAudio };
    });

    expect(result.beforeVideo).toBe(false);
    expect(result.beforeAudio).toBe(false);
    expect(result.afterVideo).toBe(true);
    expect(result.afterAudio).toBe(false);
  });

  test('criterion 10a — slotchange fires on the appropriate keyed slot', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { PickNMixin } = await import('/dist/index.js');
      class El extends PickNMixin(HTMLElement) {
        getSlotKey(child: Element) { return child.getAttribute('data-key') ?? 'default'; }
      }
      customElements.define('test-pick-n-c10a', El);

      const host = document.createElement('test-pick-n-c10a') as any;
      document.body.appendChild(host);
      await customElements.whenDefined('test-pick-n-c10a');

      const v = document.createElement('div'); v.setAttribute('data-key', 'video');
      host.appendChild(v);
      host.activateChild(v); // creates the slot lazily

      const videoSlot = host.shadowRoot!.querySelector('slot[name="video-active"]');
      if (!videoSlot) return { error: 'slot missing' };

      let changes = 0;
      videoSlot.addEventListener('slotchange', () => changes++);

      // Activate a new child to trigger a slotchange.
      const v2 = document.createElement('div'); v2.setAttribute('data-key', 'video');
      host.appendChild(v2);
      host.activateChild(v2);
      await new Promise<void>(r => setTimeout(r, 0));

      return { changes };
    });

    expect(result.changes).toBeGreaterThanOrEqual(1);
  });

});

// ===========================================================================
// SequentialMixin
// ===========================================================================

test.describe('SequentialMixin', () => {

  test('criterion 6 — on videl:done from a child, next sibling is promoted through next→active', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { PickOneMixin, SequentialMixin } = await import('/dist/index.js');
      class El extends SequentialMixin(PickOneMixin(HTMLElement) as any) {}
      customElements.define('test-seq-c6', El as unknown as CustomElementConstructor);

      const host = document.createElement('test-seq-c6') as any;
      document.body.appendChild(host);
      await customElements.whenDefined('test-seq-c6');

      const c1 = document.createElement('div');
      const c2 = document.createElement('div');
      const c3 = document.createElement('div');
      host.appendChild(c1);
      host.appendChild(c2);
      host.appendChild(c3);

      host.activateChild(c1);
      host.preloadChild(c2);

      // c1 fires videl:done
      c1.dispatchEvent(new CustomEvent('videl:done', { bubbles: true }));

      return {
        c1Slot: c1.getAttribute('slot'),
        c2Slot: c2.getAttribute('slot'),
        c3Slot: c3.getAttribute('slot'),
      };
    });

    expect(result.c1Slot).toBeNull();
    expect(result.c2Slot).toBe('active');
    expect(result.c3Slot).toBe('next');
  });

  test('criterion 7 — no next sibling: no error thrown, no slot changes', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { PickOneMixin, SequentialMixin } = await import('/dist/index.js');
      class El extends SequentialMixin(PickOneMixin(HTMLElement) as any) {}
      customElements.define('test-seq-c7', El as unknown as CustomElementConstructor);

      const host = document.createElement('test-seq-c7') as any;
      document.body.appendChild(host);
      await customElements.whenDefined('test-seq-c7');

      const c1 = document.createElement('div');
      host.appendChild(c1);
      host.activateChild(c1);

      try {
        c1.dispatchEvent(new CustomEvent('videl:done', { bubbles: true }));
        return { threw: false, c1Slot: c1.getAttribute('slot') };
      } catch (e: any) {
        return { threw: true, error: e.message };
      }
    });

    expect(result.threw).toBe(false);
    // c1 should have been deactivated
    expect(result.c1Slot).toBeNull();
  });

  test('criterion 8 — direct unslotted→active skip does not break sequential advancement', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { PickOneMixin, SequentialMixin } = await import('/dist/index.js');
      class El extends SequentialMixin(PickOneMixin(HTMLElement) as any) {}
      customElements.define('test-seq-c8', El as unknown as CustomElementConstructor);

      const host = document.createElement('test-seq-c8') as any;
      document.body.appendChild(host);
      await customElements.whenDefined('test-seq-c8');

      const c1 = document.createElement('div');
      const c2 = document.createElement('div');
      host.appendChild(c1);
      host.appendChild(c2);

      // Skip next — go directly to active.
      host.activateChild(c1);

      // Now complete c1 — c2 should become active.
      c1.dispatchEvent(new CustomEvent('videl:done', { bubbles: true }));

      return {
        c1Slot: c1.getAttribute('slot'),
        c2Slot: c2.getAttribute('slot'),
      };
    });

    expect(result.c1Slot).toBeNull();
    expect(result.c2Slot).toBe('active');
  });

  test('criterion 9 — deactivation cascade is recursive and synchronous', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { PickOneMixin } = await import('/dist/index.js');

      // Build a two-level hierarchy: grandparent → parent → child.
      class Inner extends PickOneMixin(HTMLElement) {}
      class Outer extends PickOneMixin(HTMLElement) {}
      customElements.define('test-cascade-inner', Inner);
      customElements.define('test-cascade-outer', Outer);

      const grandparent = document.createElement('test-cascade-outer') as any;
      document.body.appendChild(grandparent);
      await customElements.whenDefined('test-cascade-outer');
      await customElements.whenDefined('test-cascade-inner');

      const parent = document.createElement('test-cascade-inner') as any;
      grandparent.appendChild(parent);
      const child = document.createElement('div');
      parent.appendChild(child);

      grandparent.activateChild(parent);
      parent.activateChild(child);

      // Give grandparent a slot so removing it cascades.
      grandparent.setAttribute('slot', 'active');
      grandparent.removeAttribute('slot');

      // Check synchronously.
      return {
        parentSlot: parent.getAttribute('slot'),
        childSlot: child.getAttribute('slot'),
      };
    });

    expect(result.parentSlot).toBeNull();
    expect(result.childSlot).toBeNull();
  });

  test('criterion — SequentialMixin: videl:done from grandchild does NOT trigger advancement', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { PickOneMixin, SequentialMixin } = await import('/dist/index.js');
      class El extends SequentialMixin(PickOneMixin(HTMLElement) as any) {}
      customElements.define('test-seq-desc', El as unknown as CustomElementConstructor);

      const host = document.createElement('test-seq-desc') as any;
      document.body.appendChild(host);
      await customElements.whenDefined('test-seq-desc');

      const c1 = document.createElement('div');
      const c2 = document.createElement('div');
      const grandchild = document.createElement('span');
      c1.appendChild(grandchild);
      host.appendChild(c1);
      host.appendChild(c2);

      host.activateChild(c1);

      // videl:done fired from grandchild (not a direct child of host).
      grandchild.dispatchEvent(new CustomEvent('videl:done', { bubbles: true }));

      return {
        c1Slot: c1.getAttribute('slot'),
        c2Slot: c2.getAttribute('slot'),
      };
    });

    // c1 should still be active — grandchild event was ignored.
    expect(result.c1Slot).toBe('active');
    expect(result.c2Slot).toBeNull();
  });

});
