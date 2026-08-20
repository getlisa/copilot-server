import PDFDocument from "pdfkit";
import {
  amountInWords,
  loadLogo,
  loadPhotos,
  STATIC_ASSUMPTIONS,
  STATIC_COORDINATION,
  STATIC_EXCLUSIONS,
  type ProposalInput,
} from "./proposalDocx";

/**
 * PDF rendering of the same "Bid Proposal" the docx builder produces — one ProposalInput,
 * two formats. Emailed proposals attach this PDF; the in-app download stays .docx.
 */

const MARGIN = 54;
const PAGE_W = 612; // US Letter
const PAGE_H = 792;
const CONTENT_W = PAGE_W - MARGIN * 2;
const INK = "#222222";
const MUTED = "#666666";

const money = (v: number) =>
  `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function buildProposalPdf(input: ProposalInput): Promise<Buffer> {
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

  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "LETTER", margin: MARGIN });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // Flow-mode helpers: every block writes at doc.y and pdfkit paginates text itself.
      const centered = (text: string, opts: { bold?: boolean; size?: number; color?: string } = {}) =>
        doc
          .font(opts.bold ? "Helvetica-Bold" : "Helvetica")
          .fontSize(opts.size ?? 10)
          .fillColor(opts.color ?? INK)
          .text(text, MARGIN, doc.y, { width: CONTENT_W, align: "center" });
      const sectionHeader = (text: string) => {
        doc.moveDown(1);
        doc.font("Helvetica-Bold").fontSize(11).fillColor(INK)
          .text(text, MARGIN, doc.y, { width: CONTENT_W, underline: true });
        doc.moveDown(0.4);
      };
      const para = (text: string, opts: { bold?: boolean; color?: string; size?: number; italic?: boolean } = {}) =>
        doc
          .font(opts.bold ? "Helvetica-Bold" : opts.italic ? "Helvetica-Oblique" : "Helvetica")
          .fontSize(opts.size ?? 10)
          .fillColor(opts.color ?? INK)
          .text(text, MARGIN, doc.y, { width: CONTENT_W });
      const bullet = (text: string) =>
        doc.font("Helvetica").fontSize(10).fillColor(INK)
          .text(`•  ${text}`, MARGIN + 14, doc.y, { width: CONTENT_W - 14 });
      const numbered = (items: string[]) =>
        items.forEach((t, i) =>
          doc.font("Helvetica").fontSize(10).fillColor(INK)
            .text(`${i + 1}.  ${t}`, MARGIN + 14, doc.y, { width: CONTENT_W - 14 })
        );

      // --- Header: logo, contact line, title ---
      const logoTop = doc.y;
      try {
        doc.image(logo.data, (PAGE_W - 90) / 2, logoTop, { fit: [90, 90], align: "center" });
      } catch {
        /* undecodable logo — title still identifies the company */
      }
      doc.y = logoTop + 96;
      if (contactLine) centered(contactLine, { size: 9, color: MUTED });
      doc.moveDown(0.6);
      centered("Bid Proposal", { bold: true, size: 18 });
      doc.moveDown(0.4);
      centered(`Project: ${input.projectTitle}`, { bold: true });
      // The address prints once, in the Customer line — a second copy directly under the
      // title read as part of the project name.
      centered(`Customer: ${customerLine}`, { bold: true });
      centered(`Contractor: ${header.companyName}`, { bold: true });
      centered(`Date: ${dateText}`, { bold: true });

      sectionHeader("GENERAL SCOPE");
      para(
        `${header.companyName} ("Contractor") shall furnish all labor, materials, equipment, and ` +
          `supervision necessary to complete the work described herein in accordance with all ` +
          `applicable code requirements, and all state and local codes and regulations.`
      );

      sectionHeader("DETAILED SCOPE OF WORK");
      input.scopeSections.forEach((section, i) => {
        if (i > 0) doc.moveDown(0.6);
        para(`${i + 1}. ${section.title.toUpperCase()}`, { bold: true });
        section.bullets.forEach(bullet);
      });

      sectionHeader("EXCLUSIONS");
      para("The following items are specifically EXCLUDED from this scope of work:");
      numbered(input.exclusions?.length ? input.exclusions : STATIC_EXCLUSIONS);

      sectionHeader("GENERAL CONDITIONS");
      para("Coordination:", { bold: true });
      (input.coordination?.length ? input.coordination : STATIC_COORDINATION).forEach(bullet);
      para("Code Compliance:", { bold: true });
      bullet("All work shall comply with the current National Electrical Code (NEC)");
      bullet("All work shall comply with applicable state electrical code requirements");
      bullet("All work shall comply with local jurisdiction amendments and requirements");

      sectionHeader("ASSUMPTIONS");
      para("This scope of work is based on the following assumptions:");
      numbered(assumptions);

      // --- Cost / payment ---
      doc.moveDown(1);
      if (input.unpricedCount) {
        para(
          `NOTE: ${input.unpricedCount} line item(s) are not yet priced and are NOT included in ` +
            `the totals below. This proposal is incomplete until they are priced or removed.`,
          { bold: true, color: "#C00000" }
        );
        doc.moveDown(0.5);
      }
      if (input.optionTotals?.length) {
        para(`BASE SCOPE TOTAL: ${amountInWords(input.total)} (${money(input.total)})`, { bold: true });
        for (const opt of input.optionTotals) {
          doc.moveDown(0.4);
          para(`${opt.name.toUpperCase()} TOTAL: ${amountInWords(opt.total)} (${money(opt.total)})`, { bold: true });
          para(`Base Scope + ${opt.name} Combined Total: ${money(opt.combinedTotal)}`, { bold: true });
        }
        doc.moveDown(0.4);
        para(
          "Only one option will be selected and performed; option totals are alternatives and are " +
            "never combined with each other. All work to be completed in a substantial and " +
            "workmanlike manner in accordance with the scope of work. A 3% service fee required " +
            "on all Credit Card payments."
        );
      } else {
        para(
          "COST: All the above work to be completed in a substantial and workmanlike manner in " +
            `accordance with the scope of work for the sum of: ${amountInWords(input.total)} ` +
            `(${money(input.total)}). A 3% service fee required on all Credit Card payments.`
        );
      }
      doc.moveDown(0.6);
      para("PAYMENT TERMS: Payment due in full upon project completion.");
      doc.moveDown(0.6);
      para(
        "*Due to potential fluctuations in material costs, this bid is valid for 45 days from the " +
          "date of issuance. If not accepted within this period, a revised proposal may be " +
          "required to reflect current market conditions.",
        { italic: true, size: 9 }
      );

      sectionHeader("PREPARED BY:");
      para(header.companyName, { bold: true });
      if (header.companyPhone) para(header.companyPhone);
      if (header.companyEmail) para(header.companyEmail);
      if (header.licenseNumber) para(`Contractor License: ${header.licenseNumber}`);

      // --- Job photos attached in the estimator chat ---
      if (photos.length > 0) {
        sectionHeader("PROJECT PHOTOS");
        for (const p of photos) {
          // pdfkit doesn't paginate images — break the page by hand when one won't fit.
          if (doc.y + p.height > PAGE_H - MARGIN) doc.addPage();
          doc.image(p.data, MARGIN, doc.y, { fit: [p.width, p.height] });
          doc.y += p.height + 10;
        }
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
