import logger from "../../lib/logger";
import OpenAI from "openai";

/**
 * Constructed on first use, not at import. The client throws without OPENAI_API_KEY, and building
 * it eagerly made this module unimportable from the hermetic link test — the same trap that moved
 * packQuantityFromTitle out of the catalog module.
 */
let client: OpenAI | null = null;
const openai = () => (client ??= new OpenAI());

/**
 * Fallback pricing by LIVE web search against homedepot.com, for when the catalog API is
 * unreachable (quota spent, upstream down).
 *
 * This is a search, not recall: the model is given the `web_search` tool and told to report the
 * product page it actually found. That matters — a remembered price is months stale and has no
 * page behind it, while a searched one comes off the listing that exists today.
 *
 * It is still NOT catalog-grade, and the difference is the whole reason for the guardrails here.
 * A SerpApi resolve returns a product id we can re-query and verify; a search result returns
 * prose the model summarised. Measured on the first two probes (2026-08-14):
 *
 *   "A19 LED light bulb"            -> a /b/ CATEGORY page, and $2.50 against a title reading
 *                                      "(4-Pack)" — a per-bulb figure, not the pack price
 *   "1/2 in EMT set screw connector" -> /p/100204006, an id that is NOT the Halex connector we
 *                                      already hold verified as 100137321, at $0.74 vs $0.85
 *
 * So the price is treated as an estimate (stored under `priceEstimated`, blocks completion,
 * replaced by a real catalog price as soon as one can be fetched) and the URL is only kept when
 * it has the shape of a real product page. Verifying it by fetching is not available to us:
 * Home Depot answers 403 to every request from our IPs, including URLs known to be good, so a
 * failed fetch would prove nothing.
 */

/** Nothing a field technician buys as a single unit costs less or more than this. */
const MIN_PLAUSIBLE_USD = 0.05;
const MAX_PLAUSIBLE_USD = 25_000;

/**
 * A real Home Depot product page is `/p/<slug>/<numeric id>`. Both halves matter: the probe
 * produced `/p/100204006` (id, no slug) and a `/b/...` browse page, and neither is a product.
 * Anything that fails this becomes a search link instead — useless-but-honest beats a link that
 * opens the wrong item under a price the customer is being quoted.
 */
const PRODUCT_URL_RE = /^https:\/\/www\.homedepot\.com\/p\/[A-Za-z0-9][A-Za-z0-9._-]*\/\d{6,}(\?.*)?$/;

const LOOKUP_SCHEMA = {
  type: "json_schema",
  name: "hd_lookup",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: ["string", "null"], description: "Exact product title from the page." },
      unitPrice: {
        type: ["number", "null"],
        description: "Price for ONE unit in USD. If the listing is a multipack, divide.",
      },
      packagePrice: {
        type: ["number", "null"],
        description: "The price shown on the listing, before any division.",
      },
      packQuantity: {
        type: ["integer", "null"],
        description: "Pieces in the package. 1 when sold singly.",
      },
      unit: { type: ["string", "null"], description: "EA, ft, ROLL, BOX." },
      url: {
        type: ["string", "null"],
        description:
          "Full homedepot.com product URL exactly as it appeared in the results. Never construct one.",
      },
      found: { type: "boolean" },
    },
    required: ["title", "unitPrice", "packagePrice", "packQuantity", "unit", "url", "found"],
  },
} as const;

const INSTRUCTIONS = [
  "Search homedepot.com for the part the user names and report the product page you actually",
  "found. This is a fallback for a field technician whose catalog lookup failed, so accuracy",
  "matters more than completeness.",
  "",
  "Report the listing's own price as packagePrice, the number of pieces in the package as",
  "packQuantity, and the price of ONE piece as unitPrice — for a 4-pack at $9.98, packagePrice",
  "is 9.98, packQuantity is 4 and unitPrice is 2.50.",
  "",
  "For url, copy a product page URL exactly as it appeared in your search results — the form",
  "https://www.homedepot.com/p/<name>/<id>. NEVER construct, shorten or complete a URL, and",
  "never return a category, search or browse page. If you did not see a product page URL, set",
  "url null; that is expected and fine.",
  "",
  "Set found false with everything null when the request is labour, a diagnostic task, names no",
  "specific product, or you cannot find it on homedepot.com. A blank line is a correct answer.",
].join("\n");

export interface HomeDepotLookup {
  itemName: string;
  unitPrice: number;
  unit: string | null;
  packQuantity: number | null;
  /** Only ever a URL matching the real product-page shape; null otherwise. */
  productLink: string | null;
  /** Always set — a search we build ourselves, so it always resolves. */
  searchLink: string;
}

/** Home Depot search for a term. Built by us, so unlike a reported URL it is always valid. */
export function homeDepotSearchLink(term: string): string {
  return `https://www.homedepot.com/s/${encodeURIComponent(term.trim())}`;
}

/** True when a URL is shaped like a real Home Depot product page. */
export function isProductUrl(url: unknown): url is string {
  return typeof url === "string" && PRODUCT_URL_RE.test(url.trim());
}

/**
 * Look one part up on homedepot.com via web search. Null when nothing usable came back —
 * which leaves the line blank, the honest outcome.
 */
export async function lookupHomeDepotViaWebSearch(
  searchTerm: string,
  opts?: { model?: string; signal?: AbortSignal }
): Promise<HomeDepotLookup | null> {
  const term = searchTerm.trim();
  if (!term) return null;

  let parsed: any = null;
  try {
    const response = (await openai().responses.create(
      {
        model: opts?.model ?? process.env.ESTIMATE_MODEL ?? "gpt-5.4-mini",
        instructions: INSTRUCTIONS,
        input: `Part: ${term}`,
        tools: [{ type: "web_search_preview" }],
        tool_choice: "auto",
        text: { format: LOOKUP_SCHEMA },
        max_output_tokens: 1200,
      } as any,
      { signal: opts?.signal }
    )) as any;
    parsed = JSON.parse(response.output_text || "null");
  } catch (err) {
    logger.warn("Home Depot web-search lookup failed", {
      searchTerm: term,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (!parsed?.found) {
    logger.info("Web-search lookup found nothing", { searchTerm: term });
    return null;
  }

  const price = typeof parsed.unitPrice === "number" ? parsed.unitPrice : null;
  if (price == null || !Number.isFinite(price)) return null;

  // Outside these bounds it is not a retail price for one part, whatever was meant by it. A $0
  // line reads as free and a $90,000 line as a typo, and both look exactly like a real price
  // once they are sitting on a customer's quote.
  if (price < MIN_PLAUSIBLE_USD || price > MAX_PLAUSIBLE_USD) {
    logger.warn("Web-search price outside plausible bounds; refusing", {
      searchTerm: term,
      unitPrice: price,
    });
    return null;
  }

  const pack =
    Number.isInteger(parsed.packQuantity) && parsed.packQuantity > 0 && parsed.packQuantity <= 500
      ? parsed.packQuantity
      : null;
  const productLink = isProductUrl(parsed.url) ? parsed.url.trim() : null;
  if (parsed.url && !productLink) {
    logger.info("Web-search returned a non-product URL; using a search link instead", {
      searchTerm: term,
      rejected: String(parsed.url).slice(0, 120),
    });
  }

  return {
    itemName: (typeof parsed.title === "string" && parsed.title.trim()) || term,
    unitPrice: Math.round(price * 100) / 100,
    unit: (typeof parsed.unit === "string" && parsed.unit.trim()) || null,
    packQuantity: pack,
    productLink,
    searchLink: homeDepotSearchLink(term),
  };
}
