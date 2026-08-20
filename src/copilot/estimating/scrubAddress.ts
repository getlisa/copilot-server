// Kept free of imports on purpose: check-customer-details.ts runs inside the Docker build
// with no DATABASE_URL, so nothing on this file's import chain may touch src/lib/prisma.

/**
 * Deterministic guard behind the prompt rule that a project title names the WORK only: the
 * title prints on the proposal docx/PDF and in the email subject and greeting line, where a
 * street address reads as a mail-merge mistake — and the address already has its own field on
 * every one of those surfaces.
 *
 * Two passes: every known address string is removed verbatim, then a street-address-shaped
 * fragment ("... at 3400 Stockman Rd") is cut even when the model worded it differently from
 * the stored address.
 * ponytail: the second pass is a regex heuristic (digits + up to 4 words + a street suffix);
 * a spelled-out or suffix-less address can slip past it — the known-address pass and the
 * prompt rule are the primary guards, this catches the common shape.
 */
const STREET_SUFFIX =
  "(?:street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|drive|dr|court|ct|way|place|pl|circle|cir|terrace|ter|highway|hwy|parkway|pkwy)";
const STREET_FRAGMENT = new RegExp(
  String.raw`(?:\b(?:at|near|on)\s+)?\b\d{1,6}\s+(?:[A-Za-z0-9'.]+\s+){0,4}?` +
    STREET_SUFFIX +
    String.raw`\b\.?(?:\s*(?:apt|suite|ste|unit)\.?\s*\S+)?`,
  "gi"
);

export function scrubAddressFromTitle(
  title: string,
  knownAddresses: (string | null | undefined)[]
): string {
  let t = title;
  for (const addr of knownAddresses) {
    const a = addr?.trim();
    if (!a) continue;
    const escaped = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(String.raw`(?:\b(?:at|near|on)\s+)?` + escaped, "gi"), "");
  }
  t = t.replace(STREET_FRAGMENT, "");
  return t
    .replace(/\s{2,}/g, " ")
    .replace(/\s*[—–,:;@-]+\s*$/g, "")
    .replace(/^\s*[—–,:;@-]+\s*/g, "")
    .trim();
}
