import logger from "./logger";

/**
 * Turn a typed address into the components QuickBooks wants (T-65).
 *
 * QuickBooks stores `BillAddr` as fields — Line1, City, CountrySubDivisionCode, PostalCode — not
 * as a line of prose, and a technician standing in a driveway types a line of prose. This is the
 * translation, and it lives in its own module rather than inside `qboIngest` on purpose: that
 * file already needed dependency injection to break an import cycle with `qbo.ts`, and pulling
 * the estimate service into it would build a second one.
 *
 * **It restructures; it never invents.** The model may normalise what is present — "tucson az"
 * becomes Tucson / AZ, "Californa" becomes CA, a spelled-out state becomes its two-letter code —
 * but a component that is not in the input comes back null and is named in `missing`. That is a
 * deliberate reading of "complete the address": ask the person for the part that is absent.
 * The alternative is worse than it looks. A plausible ZIP is the single field that decides which
 * tax jurisdiction an estimate falls in, so a guess does not produce a slightly wrong address —
 * it produces a confidently wrong tax rate, on a document a customer signs.
 *
 * Best-effort by contract: the LLM sits on the customer-create path, so every failure — no API
 * key, a timeout, malformed JSON — degrades to "unparsed" and lets the caller save the freeform
 * text it already has. Creating a customer must never fail because a parser did.
 *
 * `callStructured` is imported LAZILY, inside the call. Its module builds an OpenAI client at
 * import time and throws outright when OPENAI_API_KEY is unset — so a static import here would
 * travel up through `qboIngest` and take down every check script, and with them `npm test` in
 * the Docker build, which has no key. A module that is only sometimes needed should only
 * sometimes be loaded.
 */

export interface ParsedAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  /** Two-letter code — QuickBooks calls this CountrySubDivisionCode. */
  state: string | null;
  postalCode: string | null;
  country: string | null;
  /** Components absent from the input, so the UI can ask for exactly those. */
  missing: string[];
}

const EMPTY: ParsedAddress = {
  line1: null,
  line2: null,
  city: null,
  state: null,
  postalCode: null,
  country: null,
  missing: [],
};

const SCHEMA = {
  name: "parsed_address",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      line1: { type: ["string", "null"], description: "Street number and name only" },
      line2: { type: ["string", "null"], description: "Unit, suite, apartment — null if absent" },
      city: { type: ["string", "null"] },
      state: { type: ["string", "null"], description: "Two-letter code, e.g. AZ" },
      postalCode: { type: ["string", "null"] },
      country: { type: ["string", "null"], description: "Two-letter code, e.g. US" },
      missing: {
        type: "array",
        items: { type: "string", enum: ["line1", "city", "state", "postalCode"] },
        description: "Components not present in the input",
      },
    },
    required: ["line1", "line2", "city", "state", "postalCode", "country", "missing"],
  },
};

const SYSTEM = `You split a US service address into components for an accounting system.

Rules, in order of importance:
1. NEVER invent a component that is not in the input. If the ZIP is absent, postalCode is null —
   do not derive it from the city, however obvious it seems. A guessed ZIP changes which tax
   jurisdiction a customer is billed under.
2. Normalising IS allowed, because it only restates what is there: expand or correct a state to
   its two-letter code ("arizona", "Arizonna" -> "AZ"), fix casing, drop noise words.
3. line1 is the street number and name. A unit, suite, or apartment goes in line2.
4. List in "missing" every one of line1, city, state, postalCode that the input does not contain.
5. Default country to "US" only when a state or ZIP makes it unambiguous; otherwise null.

Return the components and nothing else.`;

/** Anything the caller could reasonably treat as "they typed nothing". */
const blank = (s: string | null | undefined) => !s || !s.trim();

/**
 * Parse `text` into components. Returns nulls with an empty `missing` when there was nothing to
 * parse or the parse could not be completed — deliberately indistinguishable to the caller, which
 * should keep the freeform text either way and simply have nothing structured to store.
 */
export async function parseAddress(text: string | null | undefined): Promise<ParsedAddress> {
  if (blank(text)) return { ...EMPTY };
  try {
    const { callStructured } = await import("../copilot/estimate/estimateService");
    const { raw } = await callStructured({
      system: SYSTEM,
      userContent: text!.trim(),
      jsonSchema: SCHEMA,
      // A parse must not hold a customer-create request open. Well under the 30s the QBO calls
      // allow themselves, because this one is optional and that one is not.
      signal: AbortSignal.timeout(12_000),
    });
    return normalise(raw, text!);
  } catch (e) {
    logger.warn("Address parse failed; keeping the freeform text only", {
      error: e instanceof Error ? e.message : String(e),
    });
    return { ...EMPTY };
  }
}

/**
 * Trust the shape, verify the content. Two things the model can get wrong that matter:
 * a state that is not a two-letter code (QuickBooks rejects it), and a `missing` list that
 * disagrees with the components actually returned — the UI prompts from `missing`, so a stale
 * entry asks for something already supplied.
 */
function normalise(raw: unknown, original: string): ParsedAddress {
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => {
    const s = typeof v === "string" ? v.trim() : "";
    return s ? s : null;
  };

  const state = str(r.state);
  const out: ParsedAddress = {
    line1: str(r.line1),
    line2: str(r.line2),
    city: str(r.city),
    // Two letters or nothing. A model that returned "Arizona" despite the instruction would
    // otherwise be written straight into CountrySubDivisionCode and rejected by Intuit.
    state: state && /^[A-Za-z]{2}$/.test(state) ? state.toUpperCase() : null,
    postalCode: str(r.postalCode),
    country: str(r.country),
    missing: [],
  };

  // Recomputed here rather than taken on trust, so the UI can never ask for a component that is
  // sitting in the object next to the question.
  out.missing = (["line1", "city", "state", "postalCode"] as const).filter((k) => out[k] == null);

  // A parse that found nothing at all in non-empty text is a failed parse, not an address with
  // four missing parts — reporting it as the latter would make the UI demand every field of
  // someone who already typed a whole address.
  if (out.missing.length === 4 && original.trim()) return { ...EMPTY };
  return out;
}

/** The components QuickBooks accepts, or undefined when there is nothing worth sending. */
export function toBillAddr(a: {
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
}): Record<string, string> | undefined {
  const addr: Record<string, string> = {};
  if (a.addressLine1) addr.Line1 = a.addressLine1;
  if (a.addressLine2) addr.Line2 = a.addressLine2;
  if (a.city) addr.City = a.city;
  if (a.state) addr.CountrySubDivisionCode = a.state;
  if (a.postalCode) addr.PostalCode = a.postalCode;
  if (a.country) addr.Country = a.country;
  return Object.keys(addr).length ? addr : undefined;
}

/** QuickBooks' `BillAddr` back into our columns, on ingest. No LLM involved — it is already structured. */
export function fromBillAddr(billAddr: any): {
  address: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
} {
  const b = (billAddr ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => {
    const s = typeof v === "string" ? v.trim() : "";
    return s ? s : null;
  };
  // QuickBooks allows five address lines and CLARA stores two, so 2-5 are joined rather than
  // dropped: a suite number sitting in Line3 is part of where the technician has to go, and
  // `customer_qb.raw` keeping the original is only a consolation if someone thinks to look.
  const extra = [str(b.Line2), str(b.Line3), str(b.Line4), str(b.Line5)].filter(Boolean);
  const parts = {
    addressLine1: str(b.Line1),
    addressLine2: extra.length ? extra.join(", ") : null,
    city: str(b.City),
    state: str(b.CountrySubDivisionCode),
    postalCode: str(b.PostalCode),
    country: str(b.Country),
  };
  // The freeform column stays populated too, so every customer has one renderable address
  // regardless of which path created it.
  const joined = [
    parts.addressLine1,
    parts.addressLine2,
    [parts.city, parts.state].filter(Boolean).join(", "),
    parts.postalCode,
  ]
    .filter(Boolean)
    .join(", ");
  return { address: joined || null, ...parts };
}
