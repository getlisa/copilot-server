import logger from "./logger";

/**
 * SerpApi client with a rotating multi-key pool.
 *
 * Keys are discovered from NUMBERED env vars so a key can be added or removed without
 * touching code or a delimiter-joined string:
 *
 *   SERP_API_KEY_1=...
 *   SERP_API_KEY_2=...
 *   SERP_API_KEY_3=...
 *
 * `SERP_API_KEY` (unnumbered) is also accepted and sorts first, so a single-key setup keeps
 * working. Keys are never logged — only their pool index (`key#2`).
 *
 * Why a pool: the offline resolver issues 5 searches per catalog item, and SerpApi both bills
 * per search and throttles concurrency (5 parallel cold searches measured 14–32s wall clock
 * against ~13s for one). Rotation spreads quota and concurrency across keys; a key that
 * reports quota exhaustion or 429 is put in cooldown and the next key is tried.
 */

const SEARCH_ENDPOINT = "https://serpapi.com/search";

/** How long a key sits out after a 429 / quota-exhausted response. */
const COOLDOWN_MS = Number(process.env.SERP_KEY_COOLDOWN_MS) > 0
  ? Number(process.env.SERP_KEY_COOLDOWN_MS)
  : 15 * 60 * 1000;

/**
 * `engine=home_depot_product` requires a delivery ZIP — without one SerpApi returns a bare
 * `null` body rather than an error. Home Depot prices are store-specific, so this SHOULD be
 * set per company (SERP_DELIVERY_ZIP) once regional pricing matters. Until then this default
 * keeps the resolver working with no configuration; it is a ZIP verified against this API.
 */
const DEFAULT_DELIVERY_ZIP = "04401";

export function deliveryZip(): string {
  return process.env.SERP_DELIVERY_ZIP?.trim() || DEFAULT_DELIVERY_ZIP;
}

interface PoolKey {
  /** 1-based pool index, safe to log. The value itself never is. */
  index: number;
  value: string;
  /** Epoch ms until which this key is skipped. 0 = available. */
  cooldownUntil: number;
}

let pool: PoolKey[] | null = null;
let cursor = 0;

/**
 * Discover the key pool from env. Sorted by numeric suffix so rotation order is stable and
 * predictable across restarts. Unnumbered SERP_API_KEY sorts first.
 */
function getPool(): PoolKey[] {
  if (pool) return pool;

  const found: { n: number; value: string }[] = [];

  const bare = process.env.SERP_API_KEY?.trim();
  if (bare) found.push({ n: 0, value: bare });

  for (const [name, raw] of Object.entries(process.env)) {
    const m = name.match(/^SERP_API_KEY_(\d+)$/);
    const value = raw?.trim();
    if (m && value) found.push({ n: Number(m[1]), value });
  }

  found.sort((a, b) => a.n - b.n);

  // De-duplicate in case the same key is set twice under different names.
  const seen = new Set<string>();
  pool = found
    .filter((k) => (seen.has(k.value) ? false : (seen.add(k.value), true)))
    .map((k, i) => ({ index: i + 1, value: k.value, cooldownUntil: 0 }));

  logger.info("SerpApi key pool initialised", { keys: pool.length });
  return pool;
}

export function keysConfigured(): number {
  return getPool().length;
}

/** Keys not currently in cooldown — expose on a health endpoint so exhaustion is visible. */
export function keysAvailable(): number {
  const now = Date.now();
  return getPool().filter((k) => k.cooldownUntil <= now).length;
}

/** Round-robin over available keys, starting from the rotation cursor. */
function nextKey(exclude: Set<number>): PoolKey | null {
  const keys = getPool();
  if (keys.length === 0) return null;
  const now = Date.now();

  for (let i = 0; i < keys.length; i++) {
    const candidate = keys[(cursor + i) % keys.length];
    if (exclude.has(candidate.index)) continue;
    if (candidate.cooldownUntil > now) continue;
    cursor = (cursor + i + 1) % keys.length;
    return candidate;
  }
  return null;
}

function markExhausted(key: PoolKey, reason: string) {
  key.cooldownUntil = Date.now() + COOLDOWN_MS;
  logger.warn("SerpApi key cooling down", {
    key: `key#${key.index}`,
    reason,
    cooldownMs: COOLDOWN_MS,
    keysAvailable: keysAvailable(),
  });
}

/** SerpApi signals quota exhaustion in the body, not always via status. */
function isQuotaError(status: number, body: any): boolean {
  if (status === 429) return true;
  const msg = typeof body?.error === "string" ? body.error.toLowerCase() : "";
  return msg.includes("run out of searches") || msg.includes("exceeded") || msg.includes("quota");
}

export class SerpApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "SerpApiError";
  }
}

/**
 * One SerpApi GET with key rotation. Params are sent exactly as the documented query
 * interface expects; values are URL-encoded (spaces in `q` must be encoded or SerpApi
 * rejects the request).
 *
 * On quota/429 the key is cooled down and the call is retried on the next available key.
 */
async function request(params: Record<string, string>, signal?: AbortSignal): Promise<any> {
  const tried = new Set<number>();

  for (;;) {
    const key = nextKey(tried);
    if (!key) {
      throw new SerpApiError(
        keysConfigured() === 0
          ? "No SerpApi keys configured (set SERP_API_KEY_1, SERP_API_KEY_2, …)"
          : "All SerpApi keys are exhausted or cooling down"
      );
    }
    tried.add(key.index);

    const url = new URL(SEARCH_ENDPOINT);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("api_key", key.value);

    let res: Response;
    try {
      res = await fetch(url, { signal });
    } catch (err) {
      if ((err as any)?.name === "AbortError") throw err;
      throw new SerpApiError(err instanceof Error ? err.message : String(err));
    }

    const body = await res.json().catch(() => null);

    if (isQuotaError(res.status, body)) {
      markExhausted(key, body?.error ?? `HTTP ${res.status}`);
      continue; // retry on the next key
    }
    if (!res.ok) {
      throw new SerpApiError(body?.error ?? `SerpApi HTTP ${res.status}`, res.status);
    }
    if (body?.error) {
      // Non-quota API error (e.g. `sort` is not supported for Home Depot US) — do not retry.
      throw new SerpApiError(body.error);
    }
    return body;
  }
}

/** Product shape kept from a Home Depot search result. */
export interface HdSearchProduct {
  productId: string;
  title: string;
  brand?: string;
  modelNumber?: string;
  price?: number;
  unit?: string;
  rating?: number;
  reviews?: number;
  link?: string;
  thumbnail?: string;
}

/**
 * Home Depot links come back on the `apionline.homedepot.com` host, which is not the
 * customer-facing storefront. Rewrite to `www.` before anything is displayed or stored.
 */
export function canonicalHomeDepotLink(link?: string): string | undefined {
  if (!link) return undefined;
  return link.replace("://apionline.homedepot.com", "://www.homedepot.com");
}

function mapProduct(p: any): HdSearchProduct {
  return {
    productId: String(p?.product_id ?? ""),
    title: String(p?.title ?? ""),
    brand: p?.brand ?? undefined,
    modelNumber: p?.model_number ?? undefined,
    price: typeof p?.price === "number" ? p.price : undefined,
    unit: p?.unit ?? undefined,
    rating: typeof p?.rating === "number" ? p.rating : undefined,
    reviews: typeof p?.reviews === "number" ? p.reviews : undefined,
    link: canonicalHomeDepotLink(p?.link),
    thumbnail: Array.isArray(p?.thumbnails?.[0]) ? p.thumbnails[0].at(-1) : undefined,
  };
}

/**
 * `engine=home_depot` search. Note: `sort` is deliberately NOT supported — SerpApi rejects
 * it for the US storefront ("`sort` can't be used in the Home Depot US").
 */
export async function searchHomeDepot(
  query: string,
  opts?: { country?: string; signal?: AbortSignal }
): Promise<HdSearchProduct[]> {
  const body = await request(
    { engine: "home_depot", country: opts?.country ?? "us", q: query },
    opts?.signal
  );
  const products = Array.isArray(body?.products) ? body.products : [];
  return products.map(mapProduct).filter((p: HdSearchProduct) => p.productId && p.title);
}

/** Per-unit economics + availability. Only ever called for a chosen winner. */
export interface HdProductDetail extends HdSearchProduct {
  /** price / package_quantity — the guard against quoting a 12-pack price as a unit price. */
  unitPrice?: number;
  packageQuantity?: number;
  availability?: string;
  upc?: string;
  storeSku?: string;
}

/**
 * `engine=home_depot_product`. `delivery_zip` is REQUIRED — without it SerpApi returns a
 * bare `null` body rather than an error, so it is validated up front.
 */
export async function getHomeDepotProduct(
  productId: string,
  opts?: { deliveryZip?: string; signal?: AbortSignal }
): Promise<HdProductDetail | null> {
  const body = await request(
    {
      engine: "home_depot_product",
      product_id: productId,
      delivery_zip: opts?.deliveryZip ?? deliveryZip(),
    },
    opts?.signal
  );
  const r = body?.product_results;
  if (!r) return null;

  const price = typeof r.price === "number" ? r.price : undefined;
  const packageQuantity = typeof r.package_quantity === "number" ? r.package_quantity : undefined;
  const perUnit = typeof r.price_per_unit === "number" ? r.price_per_unit : undefined;

  return {
    productId: String(r.product_id ?? productId),
    title: String(r.title ?? ""),
    brand: typeof r.brand === "string" ? r.brand : r?.brand?.name,
    modelNumber: r.model_number ?? undefined,
    price,
    unit: r.unit ?? undefined,
    rating: typeof r.rating === "number" ? r.rating : undefined,
    reviews: typeof r.reviews === "number" ? r.reviews : undefined,
    link: canonicalHomeDepotLink(r.link),
    unitPrice: perUnit ?? (price != null ? price / (packageQuantity || 1) : undefined),
    packageQuantity,
    availability: r.availability_type ?? undefined,
    upc: r.upc ?? undefined,
    storeSku: r.store_sku_number ?? undefined,
  };
}
