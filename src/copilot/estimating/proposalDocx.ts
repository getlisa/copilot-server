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

export interface ProposalInput {
  header: QuoteHeader;
  projectTitle: string;
  projectAddress: string;
  date: Date;
  /** Numbered DETAILED SCOPE OF WORK sections describing the work to be performed. */
  scopeSections: ProposalScopeSection[];
  /** Overrides the static defaults when the caller has real assumptions. */
  assumptions?: string[];
  total: number;
}

// ponytail: boilerplate constants; make data-driven when quotes carry them
const STATIC_EXCLUSIONS = [
  "Patching or repair of walls, ceilings, or finishes of any kind",
  "Painting or finishing of any kind",
  "Any additional work not included in this bid — such work will be quoted separately upon discovery",
  "Moving of materials or obstructions impeding the work — work area must be clear and accessible prior to Contractor commencing work",
];

const STATIC_ASSUMPTIONS = [
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

async function loadLogo(
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
  const contactLine = [header.companyPhone, header.companyEmail].filter(Boolean).join("  |  ");
  const customerLine = [header.customerName, header.billingAddress].filter(Boolean).join("  |  ");
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
          ...(input.projectAddress ? [centered([new TextRun({ text: input.projectAddress })])] : []),
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
          ...STATIC_EXCLUSIONS.map((t) => numbered(t, 0)),

          sectionHeader("GENERAL CONDITIONS"),
          new Paragraph({ children: [new TextRun({ text: "Coordination:", bold: true })] }),
          bullet("Contractor will coordinate work schedule with homeowner to minimize disruption"),
          bullet(
            "Homeowner should expect a brief power interruption during panel troubleshooting and repair"
          ),
          bullet(
            "Contractor will notify homeowner prior to removal of shiplap or cutting of sheetrock"
          ),
          new Paragraph({ children: [new TextRun({ text: "Code Compliance:", bold: true })] }),
          bullet("All work shall comply with the current National Electrical Code (NEC)"),
          bullet("All work shall comply with Idaho state electrical code requirements"),
          bullet("All work shall comply with local jurisdiction amendments and requirements"),

          sectionHeader("ASSUMPTIONS"),
          new Paragraph({
            children: [new TextRun({ text: "This scope of work is based on the following assumptions:" })],
          }),
          ...assumptions.map((t) => numbered(t, 1)),

          // --- Cost / payment ---
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
          ...(header.companyAddress
            ? [new Paragraph({ children: [new TextRun({ text: header.companyAddress })] })]
            : []),
          ...(header.companyPhone
            ? [new Paragraph({ children: [new TextRun({ text: header.companyPhone })] })]
            : []),
          ...(header.companyEmail
            ? [new Paragraph({ children: [new TextRun({ text: header.companyEmail })] })]
            : []),
          ...(header.licenseNumber
            ? [new Paragraph({ children: [new TextRun({ text: `Contractor License: ${header.licenseNumber}` })] })]
            : []),
        ],
      },
    ],
  });

  return Packer.toBuffer(doc);
}
