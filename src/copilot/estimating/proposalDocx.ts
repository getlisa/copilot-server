import {
  AlignmentType,
  Document,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import { QuoteHeader } from "../estimate/pdf/quoteHeader";
import { CLARA_LOGO_PNG_BASE64 } from "../estimate/pdf/claraLogo";
import { getObjectBufferFromS3 } from "../../lib/s3";
import logger from "../../lib/logger";

/**
 * Branded "Bid Proposal" Word export modeled on the contractor bid-proposal template:
 * logo + contact header, project block, scope sections, cost-in-words, PREPARED BY.
 * Company branding (logo, name, phone, email, address, license) comes from the DB via
 * QuoteHeader; anything missing falls back to technician info / the Clara logo.
 */

export interface ProposalScopeSection {
  title: string;
  bullets: string[];
}

export interface ProposalOptionTotal {
  /** As shown to the customer, e.g. "OPTION A – Shed Trench and Empty Raceway". */
  name: string;
  total: number;
  /** Base scope + this option — what the customer pays if they choose it. */
  combinedTotal: number;
}

/** One row of the templated lineItems table. Prices are the marked-up display prices. */
export interface ProposalLineItem {
  code?: string | null;
  description: string;
  quantity?: number | null;
  unit?: string | null;
  unitPrice?: number | null;
  totalPrice?: number | null;
  /** Set when the line belongs to a mutually-exclusive option group. */
  optionGroup?: string | null;
  /** Labor lines print under the labor subtotal in the estimate-style document. */
  isLabor?: boolean;
  /** Where the price came from (pricebook name / HD fallback), shown as the row's sub-line. */
  priceSource?: string | null;
  /** No price found yet — the estimate layout prints these as "PENDING" rows at $0.00. */
  unmatched?: boolean;
}

export interface ProposalInput {
  header: QuoteHeader;
  /** Itemized lines for templates with a lineItems table block; absent = block prints nothing. */
  lineItems?: ProposalLineItem[];
  /** Company terms & conditions lines (companies.footer_terms), for the estimate layout. */
  terms?: string[];
  projectTitle: string;
  date: Date;
  /** Numbered DETAILED SCOPE OF WORK sections describing the work to be performed. */
  scopeSections: ProposalScopeSection[];
  /** Overrides the static defaults when the caller has real assumptions. */
  assumptions?: string[];
  /** Job-specific EXCLUSIONS; falls back to the standard set. */
  exclusions?: string[];
  /** Job-specific Coordination bullets; falls back to job-neutral defaults. */
  coordination?: string[];
  /** Base-scope total. With optionTotals present this is the base alone, never a grand sum. */
  total: number;
  /**
   * Alternative option groups priced independently. Mutually exclusive by definition —
   * the document never adds them together; each renders its own combined total.
   */
  optionTotals?: ProposalOptionTotal[];
  /** Lines with no price yet. Anything > 0 renders an explicit warning by the COST line. */
  unpricedCount?: number;
  /** Chat-attached job photos (S3), rendered as a PROJECT PHOTOS section at the end. */
  photos?: { s3Key: string; mimeType: string }[];
}

export const STATIC_EXCLUSIONS = [
  "Patching or repair of walls, ceilings, or finishes of any kind",
  "Painting or finishing of any kind",
  "Any additional work not included in this bid — such work will be quoted separately upon discovery",
  "Moving of materials or obstructions impeding the work — work area must be clear and accessible prior to Contractor commencing work",
];

// Job-neutral fallbacks only — anything customer-type- or scope-specific (homeowner vs
// customer, outage duration, access work) must come from the narrative, not a constant:
// these bullets go on EVERY proposal, and one job's conditions stamped on another job's
// document misstates what that customer agreed to.
export const STATIC_COORDINATION = [
  "Contractor will coordinate work schedule with the customer to minimize disruption",
  "Contractor will provide advance notice before any work requiring power outages",
];

export const STATIC_ASSUMPTIONS = [
  "Work area is accessible and clear of materials or obstructions prior to Contractor's arrival",
  "Site conditions are as represented during initial assessment",
  "Work will be performed during normal business hours (Monday–Friday, 7:00 AM – 5:00 PM)",
  "This proposal assumes no bonding requirements. If bonds are required, the cost will be added to the contract price.",
];

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen",
  "Eighteen", "Nineteen",
];
const TENS = [
  "", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety",
];

function belowThousand(n: number): string {
  const parts: string[] = [];
  if (n >= 100) {
    parts.push(`${ONES[Math.floor(n / 100)]} Hundred`);
    n %= 100;
  }
  if (n >= 20) {
    parts.push(n % 10 ? `${TENS[Math.floor(n / 10)]}-${ONES[n % 10]}` : TENS[Math.floor(n / 10)]);
  } else if (n > 0) {
    parts.push(ONES[n]);
  }
  return parts.join(" ");
}

/** "$1,825.00" -> "One Thousand Eight Hundred Twenty-Five Dollars" (cents appended when non-zero). */
export function amountInWords(amount: number): string {
  const dollars = Math.floor(amount);
  const cents = Math.round((amount - dollars) * 100);
  const scales: [number, string][] = [
    [1_000_000_000, "Billion"],
    [1_000_000, "Million"],
    [1_000, "Thousand"],
  ];
  let n = dollars;
  const parts: string[] = [];
  for (const [scale, name] of scales) {
    if (n >= scale) {
      parts.push(`${belowThousand(Math.floor(n / scale))} ${name}`);
      n %= scale;
    }
  }
  if (n > 0 || parts.length === 0) parts.push(belowThousand(n) || "Zero");
  let words = `${parts.join(" ")} Dollars`;
  if (cents > 0) words += ` and ${belowThousand(cents)} Cents`;
  return words;
}

const money = (v: number) =>
  `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function loadLogo(
  logoUrl: string | null
): Promise<{ data: Buffer; type: "png" | "jpg" }> {
  if (logoUrl) {
    const type: "png" | "jpg" = /\.jpe?g(\?|$)/i.test(logoUrl) ? "jpg" : "png";
    try {
      // logo_url is either a full URL (CDN/external) or a bare S3 key
      // (stored by company registration when no public CDN is configured).
      if (/^https?:\/\//i.test(logoUrl)) {
        const res = await fetch(logoUrl);
        if (res.ok) return { data: Buffer.from(await res.arrayBuffer()), type };
        logger.warn("Proposal logo fetch failed; using Clara logo", { logoUrl, status: res.status });
      } else {
        return { data: await getObjectBufferFromS3(logoUrl), type };
      }
    } catch (err) {
      logger.warn("Proposal logo load failed; using Clara logo", {
        logoUrl,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { data: Buffer.from(CLARA_LOGO_PNG_BASE64, "base64"), type: "png" };
}

/**
 * Pixel dimensions read straight from the file header (PNG IHDR / JPEG SOF), so photos keep
 * their aspect ratio without an image library. Null when unreadable — caller falls back to 4:3.
 * ponytail: EXIF orientation is ignored; add a rotation pass if sideways phone photos show up.
 */
export function imageDims(buf: Buffer, type: "png" | "jpg"): { width: number; height: number } | null {
  try {
    if (type === "png") {
      if (buf.length < 24) return null;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      // SOF0–SOF15 carry dimensions, except DHT/JPG/DAC markers in that range.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  } catch {
    /* fall through */
  }
  return null;
}

const PHOTO_MAX_W = 400;
const PHOTO_MAX_H = 480;

/** Load photo buffers from S3, skipping unsupported types and failed fetches. */
export async function loadPhotos(
  photos: { s3Key: string; mimeType: string }[]
): Promise<{ data: Buffer; type: "png" | "jpg"; width: number; height: number }[]> {
  const loaded: { data: Buffer; type: "png" | "jpg"; width: number; height: number }[] = [];
  for (const p of photos) {
    const type: "png" | "jpg" | null = /png/i.test(p.mimeType)
      ? "png"
      : /jpe?g/i.test(p.mimeType)
        ? "jpg"
        : null;
    if (!type) {
      logger.warn("Proposal photo skipped: unsupported type", { s3Key: p.s3Key, mimeType: p.mimeType });
      continue;
    }
    try {
      const data = await getObjectBufferFromS3(p.s3Key);
      const dims = imageDims(data, type) ?? { width: 4, height: 3 };
      const scale = Math.min(PHOTO_MAX_W / dims.width, PHOTO_MAX_H / dims.height);
      loaded.push({
        data,
        type,
        width: Math.round(dims.width * scale),
        height: Math.round(dims.height * scale),
      });
    } catch (err) {
      logger.warn("Proposal photo load failed; skipping", {
        s3Key: p.s3Key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return loaded;
}

const sectionHeader = (text: string) =>
  new Paragraph({
    spacing: { before: 300, after: 150 },
    children: [new TextRun({ text, bold: true, underline: {} })],
  });

const centered = (children: TextRun[]) =>
  new Paragraph({ alignment: AlignmentType.CENTER, children });

const bullet = (text: string) =>
  new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text })] });

const numbered = (text: string, instance: number) =>
  new Paragraph({
    numbering: { reference: "proposal-numbered", level: 0, instance },
    children: [new TextRun({ text })],
  });

export async function buildProposalDocx(input: ProposalInput): Promise<Buffer> {
  const { header } = input;
  const logo = await loadLogo(header.logoUrl);
  const photos = input.photos?.length ? await loadPhotos(input.photos) : [];
  const contactLine = [header.companyPhone, header.companyEmail].filter(Boolean).join("  |  ");
  const customerLine = [header.customerName, header.billingAddress, header.customerPhone]
    .filter(Boolean)
    .join("  |  ");
  const assumptions = input.assumptions?.length ? input.assumptions : STATIC_ASSUMPTIONS;
  const dateText = input.date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: "proposal-numbered",
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        children: [
          // --- Header: logo, contact line, title ---
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new ImageRun({
                data: logo.data,
                type: logo.type,
                transformation: { width: 140, height: 140 },
              }),
            ],
          }),
          centered([new TextRun({ text: contactLine, size: 18, color: "666666" })]),
          new Paragraph({ text: "" }),
          centered([new TextRun({ text: "Bid Proposal", bold: true, size: 32 })]),
          // --- Project block ---
          centered([new TextRun({ text: `Project: ${input.projectTitle}`, bold: true })]),
          // The address prints once, in the Customer line below — a second copy directly
          // under the title read as part of the project name.
          centered([new TextRun({ text: `Customer: ${customerLine}`, bold: true })]),
          centered([new TextRun({ text: `Contractor: ${header.companyName}`, bold: true })]),
          centered([new TextRun({ text: `Date: ${dateText}`, bold: true })]),

          sectionHeader("GENERAL SCOPE"),
          new Paragraph({
            children: [
              new TextRun({
                text:
                  `${header.companyName} ("Contractor") shall furnish all labor, materials, equipment, and ` +
                  `supervision necessary to complete the work described herein in accordance with all ` +
                  `applicable code requirements, and all state and local codes and regulations.`,
              }),
            ],
          }),

          sectionHeader("DETAILED SCOPE OF WORK"),
          ...input.scopeSections.flatMap((section, i) => [
            new Paragraph({
              spacing: { before: i === 0 ? 0 : 200, after: 100 },
              children: [
                new TextRun({ text: `${i + 1}. ${section.title.toUpperCase()}`, bold: true }),
              ],
            }),
            ...section.bullets.map(bullet),
          ]),

          sectionHeader("EXCLUSIONS"),
          new Paragraph({
            children: [new TextRun({ text: "The following items are specifically EXCLUDED from this scope of work:" })],
          }),
          ...(input.exclusions?.length ? input.exclusions : STATIC_EXCLUSIONS).map((t) =>
            numbered(t, 0)
          ),

          sectionHeader("GENERAL CONDITIONS"),
          new Paragraph({ children: [new TextRun({ text: "Coordination:", bold: true })] }),
          ...(input.coordination?.length ? input.coordination : STATIC_COORDINATION).map(bullet),
          new Paragraph({ children: [new TextRun({ text: "Code Compliance:", bold: true })] }),
          bullet("All work shall comply with the current National Electrical Code (NEC)"),
          bullet("All work shall comply with applicable state electrical code requirements"),
          bullet("All work shall comply with local jurisdiction amendments and requirements"),

          sectionHeader("ASSUMPTIONS"),
          new Paragraph({
            children: [new TextRun({ text: "This scope of work is based on the following assumptions:" })],
          }),
          ...assumptions.map((t) => numbered(t, 1)),

          // --- Cost / payment ---
          ...(input.unpricedCount
            ? [
                new Paragraph({
                  spacing: { before: 300 },
                  children: [
                    new TextRun({
                      text:
                        `NOTE: ${input.unpricedCount} line item(s) are not yet priced and are ` +
                        `NOT included in the totals below. This proposal is incomplete until ` +
                        `they are priced or removed.`,
                      bold: true,
                      color: "C00000",
                    }),
                  ],
                }),
              ]
            : []),
          ...(input.optionTotals?.length
            ? [
                // Alternative options: each priced on its own, never added together.
                new Paragraph({
                  spacing: { before: 300 },
                  children: [
                    new TextRun({ text: "BASE SCOPE TOTAL: ", bold: true }),
                    new TextRun({
                      text: `${amountInWords(input.total)} (${money(input.total)})`,
                      bold: true,
                    }),
                  ],
                }),
                ...input.optionTotals.flatMap((opt) => [
                  new Paragraph({
                    spacing: { before: 150 },
                    children: [
                      new TextRun({ text: `${opt.name.toUpperCase()} TOTAL: `, bold: true }),
                      new TextRun({
                        text: `${amountInWords(opt.total)} (${money(opt.total)})`,
                        bold: true,
                      }),
                    ],
                  }),
                  new Paragraph({
                    children: [
                      new TextRun({
                        text: `Base Scope + ${opt.name} Combined Total: ${money(opt.combinedTotal)}`,
                        bold: true,
                      }),
                    ],
                  }),
                ]),
                new Paragraph({
                  spacing: { before: 150 },
                  children: [
                    new TextRun({
                      text:
                        "Only one option will be selected and performed; option totals are " +
                        "alternatives and are never combined with each other. All work to be " +
                        "completed in a substantial and workmanlike manner in accordance with the " +
                        "scope of work. A 3% service fee required on all Credit Card payments.",
                    }),
                  ],
                }),
              ]
            : [
                new Paragraph({
                  spacing: { before: 300 },
                  children: [
                    new TextRun({ text: "COST: ", bold: true }),
                    new TextRun({
                      text:
                        "All the above work to be completed in a substantial and workmanlike manner in " +
                        "accordance with the scope of work for the sum of: ",
                    }),
                    new TextRun({
                      text: `${amountInWords(input.total)} (${money(input.total)}).`,
                      bold: true,
                    }),
                    new TextRun({ text: " A 3% service fee required on all Credit Card payments." }),
                  ],
                }),
              ]),
          new Paragraph({
            spacing: { before: 200 },
            children: [
              new TextRun({ text: "PAYMENT TERMS: ", bold: true }),
              // ponytail: single default; add deposit variant when quotes carry terms
              new TextRun({ text: "Payment due in full upon project completion." }),
            ],
          }),
          new Paragraph({
            spacing: { before: 200 },
            children: [
              new TextRun({
                text:
                  "*Due to potential fluctuations in material costs, this bid is valid for 45 days from the date " +
                  "of issuance. If not accepted within this period, a revised proposal may be required to reflect " +
                  "current market conditions.",
                italics: true,
                size: 18,
              }),
            ],
          }),

          sectionHeader("PREPARED BY:"),
          new Paragraph({ children: [new TextRun({ text: header.companyName, bold: true })] }),
          ...(header.companyPhone
            ? [new Paragraph({ children: [new TextRun({ text: header.companyPhone })] })]
            : []),
          ...(header.companyEmail
            ? [new Paragraph({ children: [new TextRun({ text: header.companyEmail })] })]
            : []),
          ...(header.licenseNumber
            ? [new Paragraph({ children: [new TextRun({ text: `Contractor License: ${header.licenseNumber}` })] })]
            : []),

          // --- Job photos attached in the estimator chat ---
          ...(photos.length
            ? [
                sectionHeader("PROJECT PHOTOS"),
                ...photos.map(
                  (p) =>
                    new Paragraph({
                      spacing: { before: 150 },
                      children: [
                        new ImageRun({
                          data: p.data,
                          type: p.type,
                          transformation: { width: p.width, height: p.height },
                        }),
                      ],
                    })
                ),
              ]
            : []),
        ],
      },
    ],
  });

  return Packer.toBuffer(doc);
}
