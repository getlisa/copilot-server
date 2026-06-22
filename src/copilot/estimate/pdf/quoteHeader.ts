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
};

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
}): Promise<QuoteHeader> {
  const header: QuoteHeader = { ...DEFAULTS };

  try {
    const job =
      conversation.jobId != null
        ? await prisma.jobs.findUnique({ where: { id: BigInt(conversation.jobId as any) } })
        : null;

    const company = job
      ? await prisma.companies.findUnique({ where: { id: job.company_id } })
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
    }
    if (tech) {
      header.technicianName = `${tech.first_name ?? ""} ${tech.last_name ?? ""}`.trim();
      header.companyPhone = tech.phone_number ?? "";
      header.companyEmail = tech.email ?? "";
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
