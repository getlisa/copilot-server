import prisma from "../../lib/prisma";
import logger from "../../lib/logger";
import { QuoteDto } from "./quoteDto";
import { buildQuoteDocx } from "./quoteDocx";

/**
 * Quote template registry (template-config PRD US3): a template row's `renderer` keys into
 * RENDERERS below. A custom client template is a new renderer implemented in code and
 * referenced by a quote_templates row — there is no self-serve template builder in v1.
 * The quote's STAMPED templateId (set at creation) decides the renderer, so a template
 * reassignment never changes how an existing quote renders.
 */

export interface InvoiceBranding {
  name: string | null;
  logoUrl: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  licenseNumber: string | null;
  website: string | null;
  footerTerms: string | null;
}

/** Flatten a Prisma JSON address (or company city/state fields) into a single line. */
function formatAddress(company: {
  address: unknown;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
}): string | null {
  const a = (company.address ?? {}) as Record<string, unknown>;
  const parts = [a.line1, a.line2, a.street, company.city, company.state, company.postal_code, company.country]
    .filter((v) => typeof v === "string" && v.trim())
    .map((v) => (v as string).trim());
  const joined = [...new Set(parts)].join(", ");
  return joined || null;
}

/**
 * The client's own configured business details, straight from their companies row — with
 * NO Clara-branded fallbacks. An unconfigured field is null and renders as omitted (US4).
 */
export async function loadInvoiceBranding(companyId: number): Promise<InvoiceBranding> {
  const company = await prisma.companies.findUnique({ where: { id: companyId } });
  if (!company)
    return {
      name: null,
      logoUrl: null,
      address: null,
      phone: null,
      email: null,
      licenseNumber: null,
      website: null,
      footerTerms: null,
    };
  return {
    name: company.name?.trim() || null,
    logoUrl: company.logo_url,
    address: formatAddress(company),
    phone: company.phone?.trim() || null,
    email: company.email?.trim() || null,
    licenseNumber: company.license_number?.trim() || null,
    website: company.website?.trim() || null,
    footerTerms: company.footer_terms?.trim() || null,
  };
}

type Renderer = (quote: QuoteDto, branding: InvoiceBranding, config: unknown) => Promise<Buffer>;

const RENDERERS: Record<string, Renderer> = {
  // The out-of-the-box default: line items + total, branded with the client's details.
  invoice: (quote, branding) => buildQuoteDocx(quote, branding),
};

/** Render a quote under the template stamped on it (null templateId = default invoice). */
export async function renderQuoteDocument(
  quote: QuoteDto,
  companyId: number,
  templateId: number | null
): Promise<Buffer> {
  const branding = await loadInvoiceBranding(companyId);
  let rendererKey = "invoice";
  let config: unknown = {};
  if (templateId != null) {
    const template = await prisma.quoteTemplate.findUnique({ where: { id: templateId } });
    if (template) {
      rendererKey = template.renderer;
      config = template.config;
    }
  }
  const renderer = RENDERERS[rendererKey];
  if (!renderer) {
    // A row naming a renderer this build doesn't ship falls back to the default invoice
    // rather than failing the download.
    logger.warn("Unknown template renderer; using default invoice", { templateId, rendererKey });
    return RENDERERS.invoice(quote, branding, {});
  }
  return renderer(quote, branding, config);
}
