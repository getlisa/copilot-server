import { existsSync } from "fs";
import puppeteer, { type Browser } from "puppeteer-core";
import logger from "../../../lib/logger";

/**
 * HTML → PDF, via a headless Chromium.
 *
 * WHY A BROWSER. An HTML proposal template is only worth having if what the customer receives
 * is what the template says — fonts, fills, column widths, page breaks. Nothing short of a
 * browser engine renders CSS faithfully, and the JS "html to pdf" libraries support a fraction
 * of it, which would put us back to approximating the customer's document.
 *
 * puppeteer-core, NOT puppeteer: the full package downloads its own Chromium on every npm
 * install, in the build stage as well as the runtime image. Here the binary comes from the
 * image (Debian's `chromium`), named by CHROMIUM_PATH, so the dependency is a few hundred KB
 * of driver and the browser is a normal, patchable system package.
 */

/** Candidate binaries: the env var wins, then the usual Linux images, then a dev Mac. */
const CANDIDATES = [
  process.env.CHROMIUM_PATH,
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter((p): p is string => !!p);

export const chromiumPath = (): string | null => CANDIDATES.find((p) => existsSync(p)) ?? null;

/** True when this server can render HTML proposals at all. */
export const htmlPdfAvailable = (): boolean => chromiumPath() != null;

// One browser for the process, launched on first use: a cold start is ~300ms and a proposal
// download should not pay it every time. Pages are per-render and always closed.
let browserPromise: Promise<Browser> | null = null;

async function browser(): Promise<Browser> {
  const existing = await browserPromise?.catch(() => null);
  if (existing?.connected) return existing;
  const executablePath = chromiumPath();
  if (!executablePath)
    throw new Error(
      "No Chromium found for HTML proposal rendering — set CHROMIUM_PATH or install chromium"
    );
  browserPromise = puppeteer.launch({
    executablePath,
    headless: true,
    // --no-sandbox: the container already is the sandbox, and Chromium's own needs kernel
    // privileges ECS tasks do not have. --disable-dev-shm-usage: /dev/shm is 64MB in a
    // container, and a print render that outgrows it crashes the tab rather than erroring.
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
  });
  const launched = await browserPromise;
  launched.once("disconnected", () => {
    browserPromise = null;
  });
  return launched;
}

export interface HtmlPdfOptions {
  /** Seconds to allow for loading images/fonts before printing anyway. Default 15. */
  timeoutMs?: number;
}

/**
 * Render a complete HTML document to a Letter-size PDF.
 *
 * Backgrounds are printed (the template's black panels and table headers ARE the design) and
 * margins come from the document's own `@page` rule, so page geometry lives with the template
 * rather than here.
 */
export async function htmlToPdf(html: string, opts: HtmlPdfOptions = {}): Promise<Buffer> {
  const page = await (await browser()).newPage();
  try {
    // "load" (setContent's strongest option) waits for images and stylesheets, so a remote
    // logo is on the page when it prints; the timeout keeps one unreachable image from
    // holding a technician's download open indefinitely.
    await page.setContent(html, { waitUntil: "load", timeout: opts.timeoutMs ?? 15_000 });
    const pdf = await page.pdf({
      format: "letter",
      printBackground: true,
      preferCSSPageSize: true,
    });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Close the shared browser (process shutdown, tests). */
export async function closeHtmlPdfBrowser(): Promise<void> {
  const current = await browserPromise?.catch(() => null);
  browserPromise = null;
  await current?.close().catch((err) =>
    logger.warn("Closing the HTML render browser failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  );
}
