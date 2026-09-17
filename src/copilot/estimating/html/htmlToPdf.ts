import { existsSync } from "fs";
import puppeteer, { type Browser } from "puppeteer-core";
import logger from "../../../lib/logger";
import { isAllowedResource } from "./htmlSafety";

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
  /**
   * The document came from the repo (code-reviewed) rather than from an upload. Trusted pages
   * may load any public https resource; stored ones are held to the allowlist.
   */
  trusted?: boolean;
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
    // A proposal is a printed document: nothing in it needs to execute. Turning JavaScript off
    // is what makes rendering an UPLOADED template safe — it neuters anything the sanitiser
    // missed, without depending on having parsed the HTML correctly.
    await page.setJavaScriptEnabled(false);
    // And every request the page makes is vetted, so a template cannot reach the cloud
    // metadata endpoint, the private network around the container, or local files.
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (isAllowedResource(req.url(), opts.trusted === true)) return void req.continue();
      logger.warn("Blocked a resource request from a proposal template", {
        url: req.url().slice(0, 200),
        resourceType: req.resourceType(),
      });
      void req.abort();
    });
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

/** One rendered page of a document, as a PNG sized in CSS pixels. */
export interface RenderedPage {
  data: Buffer;
  width: number;
  height: number;
}

/** US Letter at 96dpi, less the half-inch margins the templates print with. */
const PAGE_W = 816;
const PAGE_H = 1056;

/**
 * How many page images a document of this pixel height needs.
 *
 * The slack matters: a document that ends a few pixels past a page boundary — a trailing
 * margin, a border — would otherwise get a second, entirely blank page, which is what a
 * customer notices first. The ceiling stops a runaway template from shooting forever.
 */
export const pageCount = (totalHeight: number): number =>
  Math.max(1, Math.min(50, Math.ceil((totalHeight - 8) / PAGE_H)));

/**
 * Render a document to one PNG per page, for embedding in a .docx.
 *
 * Word cannot express arbitrary CSS, so the only way a Word download can show a company
 * their own document is to show them a picture of it. The result is exact and NOT editable
 * — that trade is the whole point, and the caller says so in the covering text.
 *
 * ponytail: the viewport IS the page. Scrolling a page-sized window and shooting each
 * position keeps `position: fixed` furniture (the templates' legal footer) on every page,
 * which a single full-page screenshot would render once. What it does NOT do is break
 * between pages the way a printer would, so a line straddling a boundary is cut rather
 * than pushed down. Rasterising the real PDF instead (pdfjs + @napi-rs/canvas) fixes that
 * and costs a native dependency; worth it only if the cut lines actually bother anyone.
 */
export async function htmlToPageImages(
  html: string,
  opts: HtmlPdfOptions = {}
): Promise<RenderedPage[]> {
  const page = await (await browser()).newPage();
  try {
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (isAllowedResource(req.url(), opts.trusted === true)) return void req.continue();
      logger.warn("Blocked a resource request from a proposal template", {
        url: req.url().slice(0, 200),
        resourceType: req.resourceType(),
      });
      void req.abort();
    });
    await page.setViewport({ width: PAGE_W, height: PAGE_H });
    // Print media, so the template's @page rules and print-only styling apply here exactly
    // as they do when the same document is printed to PDF.
    await page.emulateMediaType("print");
    await page.setContent(html, { waitUntil: "load", timeout: opts.timeoutMs ?? 15_000 });
    // Paper. A template needs no background when it prints — the page it lands on is white —
    // so most set none and a screenshot of one comes out transparent, which every viewer
    // composites onto whatever it likes (black, in Word's case). Declared without
    // !important so a template that paints its own background still wins.
    await page.addStyleTag({ content: "html{background:#fff}" });

    const total = await page.evaluate(() => document.documentElement.scrollHeight);
    const count = pageCount(total);
    const pages: RenderedPage[] = [];
    for (let i = 0; i < count; i++) {
      await page.evaluate((y) => window.scrollTo(0, y), i * PAGE_H);
      const shot = await page.screenshot({ type: "png" });
      pages.push({ data: Buffer.from(shot), width: PAGE_W, height: PAGE_H });
    }
    return pages;
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
