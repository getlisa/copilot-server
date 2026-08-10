import prisma from "../../../lib/prisma";
import logger from "../../../lib/logger";

/**
 * Header fields for the quotation PDF, assembled best-effort from the job / company /
 * technician behind the conversation. Falls back to Clara-branded defaults so the PDF
 * always renders even when the records are sparse. (The logo is always the Clara logo.)
 */
export interface QuoteHeader {
  companyName: string;
  companyAddress: string;
  companyPhone: string;
  companyEmail: string;
  customerName: string;
  billingAddress: string;
  serviceAddress: string;
  technicianName: string;
  logoUrl: string | null;
  licenseNumber: string;
}

const DEFAULTS: QuoteHeader = {
  companyName: "Clara AI",
  companyAddress: "The Only Trades Business Needs",
  companyPhone: "",
  companyEmail: "",
  customerName: "Customer",
  billingAddress: "",
  serviceAddress: "",
  technicianName: "",
  logoUrl: null,
  licenseNumber: "",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Best-effort customer email for a job. The DB has no customer-email column, so we look
 * in jobs.meta_data under common keys. Returns the first valid-looking address, or null
 * (in which case the frontend collects one). Used to *suggest* an address to confirm.
 */
export async function loadSuggestedCustomerEmail(
  jobId: bigint | number | string | null | undefined
): Promise<string | null> {
  if (jobId == null) return null;
  try {
    const job = await prisma.jobs.findUnique({ where: { id: BigInt(jobId as any) } });
    const meta = (job?.meta_data ?? null) as Record<string, unknown> | null;
    if (!meta || typeof meta !== "object") return null;
    const candidates = [
      meta.customer_email,
      meta.customerEmail,
      meta.email,
      meta.contact_email,
      meta.contactEmail,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && EMAIL_RE.test(c.trim())) return c.trim();
    }
  } catch (err) {
    logger.warn("loadSuggestedCustomerEmail failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
}

/** Flatten a Prisma JSON address (or company city/state) into a single string. */
function formatJsonAddress(addr: unknown): string {
  if (!addr || typeof addr !== "object") return "";
  const a = addr as Record<string, unknown>;
  const parts = [a.line1, a.line2, a.street, a.address, a.city, a.state, a.postal_code, a.zip, a.country]
    .filter((v) => typeof v === "string" && v.trim())
    .map((v) => (v as string).trim());
  return [...new Set(parts)].join(", ");
}

export async function loadQuoteHeader(conversation: {
  jobId?: bigint | number | string | null;
  userId?: bigint | number | string | null;
  companyId?: number | null;
}): Promise<QuoteHeader> {
  const header: QuoteHeader = { ...DEFAULTS };

  try {
    const job =
      conversation.jobId != null
        ? await prisma.jobs.findUnique({ where: { id: BigInt(conversation.jobId as any) } })
        : null;

    const companyId = job?.company_id ?? conversation.companyId ?? null;
    const company =
      companyId != null
        ? await prisma.companies.findUnique({ where: { id: companyId } })
        : null;

    const techId = conversation.userId ?? job?.technician_id ?? null;
    const tech =
      techId != null
        ? await prisma.users.findUnique({ where: { id: BigInt(techId as any) } })
        : null;

    if (company) {
      header.companyName = company.name || header.companyName;
      const compAddr =
        formatJsonAddress(company.address) ||
        [company.city, company.state, company.postal_code, company.country]
          .filter((v) => v && String(v).trim())
          .join(", ");
      if (compAddr) header.companyAddress = compAddr;
      header.logoUrl = company.logo_url ?? null;
      header.licenseNumber = company.license_number ?? "";
      header.companyPhone = company.phone ?? "";
      header.companyEmail = company.email ?? "";
    }
    if (tech) {
      header.technicianName = `${tech.first_name ?? ""} ${tech.last_name ?? ""}`.trim();
      // Company-level contact wins; technician info fills the gaps.
      header.companyPhone ||= tech.phone_number ?? "";
      header.companyEmail ||= tech.email ?? "";
    }
    if (job) {
      header.customerName = job.job_target_name || header.customerName;
      header.serviceAddress = job.address || "";
      header.billingAddress = job.address || "";
    }
  } catch (err) {
    logger.warn("loadQuoteHeader failed; using defaults", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return header;
}
