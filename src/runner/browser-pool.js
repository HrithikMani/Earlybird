import { chromium } from 'playwright';

// One shared headless Chromium; every run gets its own isolated context.
let browserPromise;

export function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] }).then((b) => {
      b.on('disconnected', () => {
        browserPromise = undefined;
      });
      return b;
    });
    browserPromise.catch(() => {
      browserPromise = undefined;
    });
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (!browserPromise) return;
  const p = browserPromise;
  browserPromise = undefined;
  try {
    await (await p).close();
  } catch {
    // already gone
  }
}
