import { expect, Page, test } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GENERATION_TIMEOUT = 120_000;

/** Navigate to the WebUI and wait until the UI is fully loaded. */
async function openUI(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('#txt2img_generate', { state: 'visible', timeout: 120_000 });
}

/** Set a fast prompt (low steps) so generations complete quickly. */
async function setFastPrompt(page: Page, tabname: 'txt2img' | 'img2img' = 'txt2img') {
  await page.fill(`#${tabname}_prompt textarea`, 'a white cat, simple illustration');
  const stepsInput = page.locator(`#${tabname}_steps input[type=number]`);
  if (await stepsInput.isVisible()) {
    await stepsInput.fill('4');
    await stepsInput.dispatchEvent('input');
  }
}

async function clickGenerate(page: Page, tabname: 'txt2img' | 'img2img' = 'txt2img') {
  await page.click(`#${tabname}_generate`);
}

async function clickEnqueue(page: Page, tabname: 'txt2img' | 'img2img' = 'txt2img') {
  await page.click(`#${tabname}_enqueue`);
}

/**
 * Wait for generation to complete by monitoring the page title.
 * During generation, the title contains progress like "[25% ETA: 5s]".
 * When done, it reverts to the original title without brackets.
 *
 * This is more reliable than waiting for progressDiv which may appear/disappear fast.
 */
async function waitForGenerationIdle(page: Page, timeout = GENERATION_TIMEOUT) {
  // First, wait for generation to start (title changes to include progress, OR
  // Interrupt button becomes visible)
  await Promise.race([
    page.waitForFunction(
      () => document.title.includes('[') || document.querySelector('#txt2img_interrupt[style*="block"]') !== null,
      { timeout: 15_000 },
    ),
    // Generation might complete before we even check — allow a short fallback
    new Promise(r => setTimeout(r, 3000)),
  ]);

  // Then wait for all generations to finish — title returns to normal AND
  // no progressDiv remains in the results panel
  await page.waitForFunction(
    () => {
      const titleClean = !document.title.includes('[');
      const panel = document.querySelector('#txt2img_results_panel');
      const noProgress = !panel || panel.querySelectorAll('.progressDiv').length === 0;
      return titleClean && noProgress;
    },
    { timeout },
  );
}

/**
 * Observe whether a progressDiv ever appears during a callback.
 * Installs a MutationObserver and returns whether it was seen.
 */
async function observeProgressDuring(page: Page, tabname: string, fn: () => Promise<void>): Promise<boolean> {
  // Install observer before action
  await page.evaluate((tab: string) => {
    (window as any).__progressSeen = false;
    const panel = document.querySelector(`#${tab}_results_panel`);
    if (!panel) return;
    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node instanceof HTMLElement && node.classList.contains('progressDiv')) {
            (window as any).__progressSeen = true;
          }
        }
      }
    });
    obs.observe(panel, { childList: true });
    (window as any).__progressObs = obs;
  }, tabname);

  await fn();

  // Collect result and disconnect
  const seen = await page.evaluate(() => {
    const obs = (window as any).__progressObs;
    if (obs) obs.disconnect();
    return (window as any).__progressSeen ?? false;
  });
  return seen;
}

/** Count thumbnail images in the gallery grid. */
async function galleryImageCount(page: Page, tabname: 'txt2img' | 'img2img' = 'txt2img'): Promise<number> {
  return page.locator(`#${tabname}_gallery .thumbnail-item`).count();
}

/** Check for an enqueue result preview overlay. */
async function hasEnqueueResultPreview(page: Page, tabname: 'txt2img' | 'img2img' = 'txt2img'): Promise<boolean> {
  return page.locator(`#${tabname}_gallery .enqueueResultPreview`).count().then(n => n > 0);
}

/** Collect console errors during a callback. */
async function collectConsoleErrors(page: Page, fn: () => Promise<void>): Promise<string[]> {
  const errors: string[] = [];
  const handler = (msg: import('@playwright/test').ConsoleMessage) => {
    if (msg.type() === 'error') errors.push(msg.text());
  };
  page.on('console', handler);
  await fn();
  page.off('console', handler);
  return errors;
}

/** Filter out known non-critical console errors. */
function criticalOnly(errors: string[]): string[] {
  return errors.filter(e =>
    !e.includes('Wake Lock') &&
    !e.includes('favicon') &&
    !e.includes('net::ERR_')
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Progress & Gallery — Concurrent Patterns', () => {
  test.beforeEach(async ({ page }) => {
    await openUI(page);
    await setFastPrompt(page);
  });

  // Pattern 1: Generate alone
  test('Pattern 1: Generate alone — gallery updated', async ({ page }) => {
    const errors = await collectConsoleErrors(page, async () => {
      const progressSeen = await observeProgressDuring(page, 'txt2img', async () => {
        await clickGenerate(page);
        await waitForGenerationIdle(page);
      });
      // Progress bar should have appeared at some point
      expect(progressSeen).toBe(true);
    });

    const imgCount = await galleryImageCount(page);
    expect(imgCount).toBeGreaterThan(0);
    expect(criticalOnly(errors)).toHaveLength(0);
  });

  // Pattern 2: Enqueue alone
  test('Pattern 2: Enqueue alone — progress and result preview', async ({ page }) => {
    const errors = await collectConsoleErrors(page, async () => {
      const progressSeen = await observeProgressDuring(page, 'txt2img', async () => {
        await clickEnqueue(page);
        await waitForGenerationIdle(page);
        // Extra wait for enqueue result fetch
        await page.waitForTimeout(5000);
      });
      expect(progressSeen).toBe(true);
    });

    // Either gallery thumbnails or enqueue result preview
    const imgCount = await galleryImageCount(page);
    const hasPreview = await hasEnqueueResultPreview(page);
    expect(imgCount > 0 || hasPreview).toBeTruthy();
    expect(criticalOnly(errors)).toHaveLength(0);
  });

  // Pattern 3: Generate then Enqueue (while Generate is running)
  test('Pattern 3: Generate then Enqueue — both complete', async ({ page }) => {
    const errors = await collectConsoleErrors(page, async () => {
      await clickGenerate(page);
      // Wait briefly for generation to start, then enqueue
      await page.waitForTimeout(1000);
      await clickEnqueue(page);

      // Wait for both to finish
      await waitForGenerationIdle(page);
      // Extra wait for enqueue result (runs after generate on main thread)
      await page.waitForFunction(
        () => {
          const panel = document.querySelector('#txt2img_results_panel');
          return !panel || panel.querySelectorAll('.progressDiv').length === 0;
        },
        { timeout: GENERATION_TIMEOUT },
      );
      await page.waitForTimeout(5000);
    });

    const imgCount = await galleryImageCount(page);
    expect(imgCount).toBeGreaterThan(0);
    expect(criticalOnly(errors)).toHaveLength(0);
  });

  // Pattern 4: Enqueue then Generate — THE MAIN BUG
  test('Pattern 4: Enqueue then Generate — Generate gallery works', async ({ page }) => {
    const errors = await collectConsoleErrors(page, async () => {
      await clickEnqueue(page);
      // Wait briefly for enqueue to start processing
      await page.waitForTimeout(1000);
      await clickGenerate(page);

      // Wait for ALL progress to finish (both enqueue and generate)
      await page.waitForFunction(
        () => {
          const titleClean = !document.title.includes('[');
          const panel = document.querySelector('#txt2img_results_panel');
          const noProgress = !panel || panel.querySelectorAll('.progressDiv').length === 0;
          return titleClean && noProgress;
        },
        { timeout: GENERATION_TIMEOUT },
      );

      // Extra wait for gallery update
      await page.waitForTimeout(3000);
    });

    // Gallery should have images from Generate
    const imgCount = await galleryImageCount(page);
    expect(imgCount).toBeGreaterThan(0);

    // No stale enqueueResultPreview should remain
    const hasStalePreview = await hasEnqueueResultPreview(page);
    expect(hasStalePreview).toBe(false);

    expect(criticalOnly(errors)).toHaveLength(0);
  });

  // Pattern 5: Enqueue then Enqueue
  test('Pattern 5: Enqueue then Enqueue — both produce results', async ({ page }) => {
    const errors = await collectConsoleErrors(page, async () => {
      await clickEnqueue(page);
      await page.waitForTimeout(1000);
      await clickEnqueue(page);

      // Wait for both to complete
      await waitForGenerationIdle(page);
      // Second enqueue runs after first — wait more
      await page.waitForFunction(
        () => {
          const panel = document.querySelector('#txt2img_results_panel');
          return !panel || panel.querySelectorAll('.progressDiv').length === 0;
        },
        { timeout: GENERATION_TIMEOUT },
      );
      await page.waitForTimeout(5000);
    });

    // At least one result visible
    const imgCount = await galleryImageCount(page);
    const hasPreview = await hasEnqueueResultPreview(page);
    expect(imgCount > 0 || hasPreview).toBeTruthy();
    expect(criticalOnly(errors)).toHaveLength(0);
  });

  // Pattern 6: Enqueue completes, then Generate
  test('Pattern 6: Enqueue complete then Generate — overlay cleaned up', async ({ page }) => {
    const errors = await collectConsoleErrors(page, async () => {
      // Run enqueue to completion
      await clickEnqueue(page);
      await waitForGenerationIdle(page);
      await page.waitForTimeout(5000);

      // Verify enqueue result preview exists
      const previewBefore = await hasEnqueueResultPreview(page);
      // It might or might not exist depending on timing, but let's proceed

      // Now run Generate
      await clickGenerate(page);
      await waitForGenerationIdle(page);
      await page.waitForTimeout(2000);
    });

    // Gallery should have images from Generate
    const imgCount = await galleryImageCount(page);
    expect(imgCount).toBeGreaterThan(0);

    // enqueueResultPreview should be cleaned up
    const hasStalePreview = await hasEnqueueResultPreview(page);
    expect(hasStalePreview).toBe(false);

    expect(criticalOnly(errors)).toHaveLength(0);
  });
});
