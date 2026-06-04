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

  test('criterion 1 — activating a second child removes videl-state from the first', async ({ page }) => {
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
        c1State: c1.getAttribute('videl-state'),
        c2State: c2.getAttribute('videl-state'),
      };
    });

    expect(result.c1State).toBeNull();
    expect(result.c2State).toBe('active');
  });

  test('criterion 2 — preloading a second child removes videl-state from the first', async ({ page }) => {
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
        c1State: c1.getAttribute('videl-state'),
        c2State: c2.getAttribute('videl-state'),
      };
    });

    expect(result.c1State).toBeNull();
    expect(result.c2State).toBe('next');
  });

  test('criterion 3 — removing host videl-state synchronously strips videl-state from all children', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { PickOneMixin } = await import('/dist/index.js');
      class El extends PickOneMixin(HTMLElement) {}
      customElements.define('test-pick-one-c3', El);

      const host = document.createElement('test-pick-one-c3') as any;
      document.body.appendChild(host);
      await customElements.whenDefined('test-pick-one-c3');

      const active = document.createElement('div');
      const next   = document.createElement('div');
      host.appendChild(active);
      host.appendChild(next);

      host.activateChild(active);
      host.preloadChild(next);

      // Give the host a videl-state so removing it triggers deactivation cascade.
      host.setAttribute('videl-state', 'active');
      host.removeAttribute('videl-state');

      // Check immediately — no await — to verify synchronous deactivation.
      return {
        activeState: active.getAttribute('videl-state'),
        nextState:   next.getAttribute('videl-state'),
      };
    });

    expect(result.activeState).toBeNull();
    expect(result.nextState).toBeNull();
  });

  test('criterion 10 — MutationObserver fires on videl-state transitions', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { PickOneMixin } = await import('/dist/index.js');
      class El extends PickOneMixin(HTMLElement) {}
      customElements.define('test-pick-one-c10', El);

      const host = document.createElement('test-pick-one-c10') as any;
      document.body.appendChild(host);
      await customElements.whenDefined('test-pick-one-c10');

      const child = document.createElement('div');
      host.appendChild(child);

      const states: string[] = [];
      const observer = new MutationObserver(records => {
        for (const r of records) {
          if (r.attributeName === 'videl-state') {
            states.push((r.target as Element).getAttribute('videl-state') ?? 'removed');
          }
        }
      });
      observer.observe(child, { attributes: true, attributeFilter: ['videl-state'] });

      host.preloadChild(child);
      await new Promise<void>(r => setTimeout(r, 0));
      host.activateChild(child);
      await new Promise<void>(r => setTimeout(r, 0));

      observer.disconnect();
      return { states };
    });

    expect(result.states).toContain('next');
    expect(result.states).toContain('active');
  });

});

// ===========================================================================
// PickNMixin
// ===========================================================================

test.describe('PickNMixin', () => {

  test('criterion 4 — children with different keys can both hold videl-state="active"', async ({ page }) => {
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
        videoState: video.getAttribute('videl-state'),
        audioState: audio.getAttribute('videl-state'),
      };
    });

    expect(result.videoState).toBe('active');
    expect(result.audioState).toBe('active');
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
        c1State: c1.getAttribute('videl-state'),
        c2State: c2.getAttribute('videl-state'),
      };
    });

    expect(result.c1State).toBeNull();
    expect(result.c2State).toBe('active');
  });

  test('criterion 5a — different keys can both hold videl-state="next" simultaneously', async ({ page }) => {
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
        vState: v.getAttribute('videl-state'),
        aState: a.getAttribute('videl-state'),
      };
    });

    expect(result.vState).toBe('next');
    expect(result.aState).toBe('next');
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
        c1State: c1.getAttribute('videl-state'),
        c2State: c2.getAttribute('videl-state'),
      };
    });

    expect(result.c1State).toBeNull();
    expect(result.c2State).toBe('next');
  });

  test('criterion 3 (PickNMixin) — removing host videl-state synchronously deactivates all children', async ({ page }) => {
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

      host.setAttribute('videl-state', 'active');
      host.removeAttribute('videl-state');

      return {
        vState: v.getAttribute('videl-state'),
        aState: a.getAttribute('videl-state'),
      };
    });

    expect(result.vState).toBeNull();
    expect(result.aState).toBeNull();
  });

  test('criterion 11 — activateChild sets videl-state="active"; no prior state before activation', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { PickNMixin } = await import('/dist/index.js');
      class El extends PickNMixin(HTMLElement) {
        getSlotKey(child: Element) { return child.getAttribute('data-key') ?? 'default'; }
      }
      customElements.define('test-pick-n-c11', El);

      const host = document.createElement('test-pick-n-c11') as any;
      document.body.appendChild(host);
      await customElements.whenDefined('test-pick-n-c11');

      const v = document.createElement('div'); v.setAttribute('data-key', 'video');
      host.appendChild(v);

      const beforeState = v.getAttribute('videl-state');
      host.activateChild(v);
      const afterState = v.getAttribute('videl-state');

      return { beforeState, afterState };
    });

    expect(result.beforeState).toBeNull();
    expect(result.afterState).toBe('active');
  });

  test('criterion 10a — MutationObserver fires on videl-state transitions for same-key activation', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { PickNMixin } = await import('/dist/index.js');
      class El extends PickNMixin(HTMLElement) {
        getSlotKey(child: Element) { return child.getAttribute('data-key') ?? 'default'; }
      }
      customElements.define('test-pick-n-c10a', El);

      const host = document.createElement('test-pick-n-c10a') as any;
      document.body.appendChild(host);
      await customElements.whenDefined('test-pick-n-c10a');

      const v1 = document.createElement('div'); v1.setAttribute('data-key', 'video');
      const v2 = document.createElement('div'); v2.setAttribute('data-key', 'video');
      host.appendChild(v1);
      host.appendChild(v2);

      host.activateChild(v1);

      const changes: string[] = [];
      const observer = new MutationObserver(records => {
        for (const r of records) {
          if (r.attributeName === 'videl-state') {
            const which = (r.target as Element) === v1 ? 'v1' : 'v2';
            const val   = (r.target as Element).getAttribute('videl-state') ?? 'removed';
            changes.push(`${which}:${val}`);
          }
        }
      });
      observer.observe(v1, { attributes: true, attributeFilter: ['videl-state'] });
      observer.observe(v2, { attributes: true, attributeFilter: ['videl-state'] });

      // Activating v2 with same key should deactivate v1.
      host.activateChild(v2);
      await new Promise<void>(r => setTimeout(r, 0));

      observer.disconnect();
      return { changes };
    });

    // v1 was deactivated, v2 was activated.
    expect(result.changes).toContain('v1:removed');
    expect(result.changes).toContain('v2:active');
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
        c1State: c1.getAttribute('videl-state'),
        c2State: c2.getAttribute('videl-state'),
        c3State: c3.getAttribute('videl-state'),
      };
    });

    expect(result.c1State).toBeNull();
    expect(result.c2State).toBe('active');
    expect(result.c3State).toBe('next');
  });

  test('criterion 7 — no next sibling: no error thrown, no state changes', async ({ page }) => {
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
        return { threw: false, c1State: c1.getAttribute('videl-state') };
      } catch (e: any) {
        return { threw: true, error: e.message };
      }
    });

    expect(result.threw).toBe(false);
    // c1 should have been deactivated
    expect(result.c1State).toBeNull();
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
        c1State: c1.getAttribute('videl-state'),
        c2State: c2.getAttribute('videl-state'),
      };
    });

    expect(result.c1State).toBeNull();
    expect(result.c2State).toBe('active');
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

      // Give grandparent a videl-state so removing it cascades.
      grandparent.setAttribute('videl-state', 'active');
      grandparent.removeAttribute('videl-state');

      // Check synchronously.
      return {
        parentState: parent.getAttribute('videl-state'),
        childState:  child.getAttribute('videl-state'),
      };
    });

    expect(result.parentState).toBeNull();
    expect(result.childState).toBeNull();
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
        c1State: c1.getAttribute('videl-state'),
        c2State: c2.getAttribute('videl-state'),
      };
    });

    // c1 should still be active — grandchild event was ignored.
    expect(result.c1State).toBe('active');
    expect(result.c2State).toBeNull();
  });

});
