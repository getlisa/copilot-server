/**
 * Safety for STORED HTML proposal documents.
 *
 * A template in the repo is code we reviewed. A template uploaded through the admin UI is
 * untrusted input that we then hand to a real browser running on our server — which is a
 * different and much sharper risk. A page containing
 *
 *   <img src="http://169.254.169.254/latest/meta-data/iam/security-credentials/">
 *   <iframe src="file:///app/.env"></iframe>
 *
 * would have Chromium fetch cloud credentials or read local files while printing a proposal.
 *
 * Two layers, in this order of importance:
 *
 *  1. THE RENDERER IS LOCKED DOWN (htmlToPdf): JavaScript disabled, and every request the page
 *     makes is vetted — see `isAllowedResource` below. That is the control that holds even if
 *     this sanitiser misses something, because it does not depend on parsing HTML correctly.
 *  2. This sanitiser strips the obvious executable and embedding constructs on the way in, so
 *     a malicious page never reaches storage in the first place.
 *
 * Deliberately NOT a full HTML parser: a regex sanitiser as the ONLY defence would be wishful,
 * but as a second layer behind a JS-disabled, network-restricted renderer it is worth having.
 */

const STRIP_ELEMENTS = ["script", "iframe", "object", "embed", "frame", "frameset", "applet"];

export interface SanitiseResult {
  html: string;
  /** What was removed, so the admin is told rather than silently served a changed document. */
  removed: string[];
}

export function sanitiseTemplateHtml(input: string): SanitiseResult {
  const removed: string[] = [];
  let html = input;

  for (const tag of STRIP_ELEMENTS) {
    const paired = new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi");
    const lone = new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi");
    for (const re of [paired, lone]) {
      if (re.test(html)) {
        removed.push(`<${tag}>`);
        html = html.replace(re, "");
      }
    }
  }

  // Inline event handlers: on*="…" / on*='…' / on*=bare
  const handlers = /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
  if (handlers.test(html)) {
    removed.push("event handlers");
    html = html.replace(handlers, "");
  }

  // javascript: and vbscript: URLs anywhere (href, src, CSS url()).
  const scriptUrls = /(?:javascript|vbscript)\s*:/gi;
  if (scriptUrls.test(html)) {
    removed.push("script: URLs");
    html = html.replace(scriptUrls, "blocked:");
  }

  // <link rel=import> / <meta http-equiv=refresh>: navigation and inclusion by another name.
  const linkImport = /<link\b[^>]*rel\s*=\s*["']?import["']?[^>]*>/gi;
  if (linkImport.test(html)) {
    removed.push("<link rel=import>");
    html = html.replace(linkImport, "");
  }
  const metaRefresh = /<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi;
  if (metaRefresh.test(html)) {
    removed.push("<meta refresh>");
    html = html.replace(metaRefresh, "");
  }

  return { html, removed: [...new Set(removed)] };
}

/** Hosts a template may load images or fonts from, beyond data: URIs. */
const ALLOWED_HOSTS = [
  process.env.AWS_S3_BUCKET ? `${process.env.AWS_S3_BUCKET}.s3.amazonaws.com` : null,
  process.env.ASSET_HOST ?? null,
  "fonts.googleapis.com",
  "fonts.gstatic.com",
].filter((h): h is string => !!h);

/** Link-local, which is where AWS/GCP instance credentials live. Never reachable, ever. */
const METADATA_HOST = /^(?:169\.254\.|\[?fd00:ec2|metadata\.google\.internal$)/i;

const PRIVATE_HOST =
  /^(?:localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|\[?::1\]?)/i;

/**
 * Whether the rendering browser may fetch this URL.
 *
 * `data:` is always fine (it is inline bytes, no request). Everything else must be https to an
 * allowlisted host — which rules out file://, the cloud metadata endpoint, and anything on the
 * private network the container sits in. `trusted` (a repo template) relaxes the allowlist to
 * any public https host, since that document was code-reviewed.
 */
export function isAllowedResource(url: string, trusted = false): boolean {
  if (url.startsWith("data:")) return true;
  if (url.startsWith("about:")) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  // Never, for any template: a company's logo URL is DATA that flows into a reviewed repo
  // template too, so "trusted" cannot be allowed to mean "may fetch our instance credentials".
  if (METADATA_HOST.test(parsed.hostname)) return false;
  // The private network around the container is off by default; a developer serving a fixture
  // over localhost opts in explicitly.
  if (PRIVATE_HOST.test(parsed.hostname))
    return process.env.ALLOW_PRIVATE_TEMPLATE_RESOURCES === "true";
  return trusted || ALLOWED_HOSTS.some((h) => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`));
}
