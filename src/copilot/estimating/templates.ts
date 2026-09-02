import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import prisma from "../../lib/prisma";
import logger from "../../lib/logger";
import { getObjectBufferFromS3 } from "../../lib/s3";
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

const money = (v: number | null) => (v == null ? "" : `$${v.toFixed(2)}`);

/**
 * The data a custom .docx template can reference. Documented in the admin UI — keep the
 * two in sync when adding fields. Missing values render as blank (nullGetter below),
 * consistent with the branding rule of omitting the unconfigured rather than erroring.
 */
export function templateData(quote: QuoteDto, branding: InvoiceBranding) {
  return {
    companyName: branding.name ?? "",
    companyAddress: branding.address ?? "",
    companyPhone: branding.phone ?? "",
    companyEmail: branding.email ?? "",
    licenseNumber: branding.licenseNumber ?? "",
    website: branding.website ?? "",
    footerTerms: branding.footerTerms ?? "",
    date: new Date(quote.createdAt).toLocaleDateString("en-US", { dateStyle: "medium" }),
    status: quote.status,
    total: money(quote.total),
    lineItems: quote.lineItems.map((item) => ({
      description: item.description,
      quantity: item.quantity == null ? "" : String(item.quantity),
      unit: item.unit ?? "",
      unitPrice: money(item.unitPrice),
      totalPrice: money(item.totalPrice),
    })),
    optionTotals: quote.optionTotals.map((opt) => ({
      name: opt.name,
      total: money(opt.total),
      combinedTotal: money(opt.combinedTotal),
    })),
  };
}

function fillDocxTemplate(templateBuffer: Buffer, data: Record<string, unknown>): Buffer {
  const doc = new Docxtemplater(new PizZip(templateBuffer), {
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => "", // unknown/missing tags render blank, never crash a download
  });
  doc.render(data);
  return doc.getZip().generate({ type: "nodebuffer" });
}

/**
 * Compile-check an uploaded .docx template against sample data, so a broken tag is
 * rejected at upload time with docxtemplater's explanation instead of failing a
 * technician's download later. Returns null when the template is fine.
 */
export function validateDocxTemplate(templateBuffer: Buffer): string | null {
  const sample: QuoteDto = {
    id: "sample",
    conversationId: "sample",
    status: "DRAFT",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    lineItems: [],
    markupPercent: 0,
    customerName: null,
    customerAddress: null,
    customerPhone: null,
    total: 0,
    optionTotals: [],
    chosenOptionGroup: null,
    blockingFlagCount: 0,
  };
  const branding: InvoiceBranding = {
    name: "Sample Co",
    logoUrl: null,
    address: null,
    phone: null,
    email: null,
    licenseNumber: null,
    website: null,
    footerTerms: null,
  };
  try {
    fillDocxTemplate(templateBuffer, templateData(sample, branding));
    return null;
  } catch (err) {
    const e = err as { properties?: { errors?: { properties?: { explanation?: string } }[] } };
    const explanations = e.properties?.errors
      ?.map((inner) => inner.properties?.explanation)
      .filter(Boolean);
    return explanations?.length
      ? explanations.join("; ")
      : err instanceof Error
      ? err.message
      : "Not a valid .docx template";
  }
}

const RENDERERS: Record<string, Renderer> = {
  // The out-of-the-box default: line items + total, branded with the client's details.
  invoice: (quote, branding) => buildQuoteDocx(quote, branding),
  // An uploaded Word template (config.s3Key), filled with templateData placeholders.
  docx: async (quote, branding, config) => {
    const s3Key = (config as { s3Key?: string })?.s3Key;
    if (!s3Key) throw new Error("docx template row has no s3Key in config");
    const templateBuffer = await getObjectBufferFromS3(s3Key);
    return fillDocxTemplate(templateBuffer, templateData(quote, branding));
  },
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
  try {
    return await renderer(quote, branding, config);
  } catch (err) {
    // A broken custom template (deleted S3 object, tag that survived validation) must
    // never block a technician's download — fall back to the default invoice and log.
    if (rendererKey === "invoice") throw err;
    logger.error("Custom template render failed; using default invoice", {
      templateId,
      rendererKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return RENDERERS.invoice(quote, branding, {});
  }
}
