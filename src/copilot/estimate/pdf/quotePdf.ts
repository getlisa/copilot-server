import PDFDocument from "pdfkit";
import type { EstimateQuote } from "../estimateQuoteSchema";
import { CLARA_LOGO_PNG_BASE64 } from "./claraLogo";
import type { QuoteHeader } from "./quoteHeader";

/**
 * Render an estimate quotation as a PDF (Buffer), laid out like docs/Estimate.pdf:
 * Clara logo + company block, billing/service addresses, a line-item table, totals,
 * signature, Service Summary and Terms. When a `thumbnail` is supplied it is drawn on
 * the line item flagged `isIdentifiedEquipment` (the photographed equipment).
 */

export interface QuotePdfInput {
  quote: EstimateQuote;
  header: QuoteHeader;
  estimateNumber: string;
  date: Date;
  thumbnail?: { buffer: Buffer; mimeType?: string };
}

// Palette / geometry
const RED = "#d6314a";
const INK = "#222222";
const MUTED = "#777777";
const LINE = "#e2e2e2";
const HEADFILL = "#f4f4f5";
const MARGIN = 40;
const PAGE_W = 595.28; // A4
const RIGHT = PAGE_W - MARGIN;
const CONTENT_W = RIGHT - MARGIN;

// Line-item columns (x positions)
const COL = {
  item: MARGIN,
  status: 300,
  rate: 355,
  qty: 418,
  taxed: 452,
  total: 500,
};
const ITEM_W = COL.status - COL.item - 8;

function money(n: number, currency = "USD"): string {
  const sym = currency === "USD" ? "$" : `${currency} `;
  return `${sym}${(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(d: Date): string {
  const date = d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
  return `${date} ${time}`;
}

export function buildQuotePdf(input: QuotePdfInput): Promise<Buffer> {
  const { quote, header, estimateNumber, date, thumbnail } = input;

  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: MARGIN });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // ---- Header: logo (left) + company block (right) ----
      try {
        doc.image(Buffer.from(CLARA_LOGO_PNG_BASE64, "base64"), MARGIN, 36, { width: 180 });
      } catch {
        doc.fontSize(20).fillColor(RED).font("Helvetica-Bold").text("CLARA AI", MARGIN, 44);
      }

      const compX = 330;
      doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(header.companyName, compX, 40, { width: RIGHT - compX, align: "left" });
      doc.font("Helvetica").fontSize(9).fillColor(MUTED);
      const compLines = [
        header.companyAddress,
        header.companyPhone ? `Phone: ${header.companyPhone}` : "",
        header.companyEmail ? `Email: ${header.companyEmail}` : "",
      ].filter(Boolean);
      doc.text(compLines.join("\n"), compX, doc.y + 2, { width: RIGHT - compX });

      // ---- Billing / Service / Date row ----
      let y = 120;
      const colW = CONTENT_W / 3;
      const block = (label: string, lines: string[], x: number) => {
        doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(label, x, y, { width: colW - 10 });
        doc.font("Helvetica-Bold").fontSize(9).fillColor(INK).text(lines.filter(Boolean).join("\n"), x, y + 12, { width: colW - 10 });
      };
      block("Billing Address", [header.customerName, header.billingAddress], MARGIN);
      block("Service Address", [header.customerName, header.serviceAddress], MARGIN + colW);
      doc.font("Helvetica").fontSize(8).fillColor(MUTED).text("Date:", MARGIN + 2 * colW, y, { continued: true }).font("Helvetica-Bold").fillColor(INK).text(` ${formatDate(date)}`);
      doc.font("Helvetica").fontSize(8).fillColor(MUTED).text("Estimate # ", MARGIN + 2 * colW, doc.y + 2, { continued: true }).font("Helvetica-Bold").fillColor(INK).text(estimateNumber);

      // ---- Line-item table ----
      y = 185;
      // header band
      doc.rect(MARGIN, y, CONTENT_W, 22).fill(HEADFILL);
      doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8.5);
      doc.text("Line Item", COL.item + 6, y + 7);
      doc.text("Status", COL.status, y + 7);
      doc.text("Rate", COL.rate, y + 7, { width: 50, align: "right" });
      doc.text("Qty", COL.qty, y + 7, { width: 28, align: "center" });
      doc.text("Taxed", COL.taxed, y + 7, { width: 40, align: "center" });
      doc.text("Total", COL.total, y + 7, { width: RIGHT - COL.total, align: "right" });
      y += 22;

      const drawCheck = (cx: number, cy: number) => {
        doc.save().lineWidth(1.5).strokeColor("#2e9e4f");
        doc.moveTo(cx - 4, cy).lineTo(cx - 1, cy + 3).lineTo(cx + 5, cy - 4).stroke();
        doc.restore();
      };

      for (const li of quote.lineItems) {
        const taxed = li.kind === "material" || li.kind === "service";
        const showThumb = !!thumbnail && li.isIdentifiedEquipment;
        const rowPad = 8;

        const titleY = y + rowPad;
        doc.font("Helvetica").fontSize(9.5).fillColor(INK);
        const title = `${li.code} - ${li.description}`;
        const titleH = doc.heightOfString(title, { width: ITEM_W });
        doc.text(title, COL.item + 6, titleY, { width: ITEM_W });

        // muted sub-line: kind · sourceSheet
        const subY = titleY + titleH + 1;
        doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(`${li.kind} · ${li.sourceSheet}`, COL.item + 6, subY, { width: ITEM_W });
        let bottom = subY + 11;

        if (showThumb) {
          try {
            doc.image(thumbnail!.buffer, COL.item + 6, bottom + 2, { fit: [70, 52] });
            bottom += 60;
          } catch {
            /* ignore bad image */
          }
        }

        // right-side cells (aligned to the title row)
        doc.font("Helvetica").fontSize(9).fillColor(INK);
        doc.text("Quoted", COL.status, titleY, { width: 50 });
        doc.text(money(li.unitPrice, quote.currency), COL.rate, titleY, { width: 50, align: "right" });
        doc.text(`${li.quantity}${li.unit && li.unit !== "EA" ? ` ${li.unit}` : ""}`, COL.qty, titleY, { width: 28, align: "center" });
        if (taxed) drawCheck(COL.taxed + 20, titleY + 5);
        else doc.fillColor(MUTED).text("-", COL.taxed, titleY, { width: 40, align: "center" });
        doc.fillColor(INK).text(money(li.lineTotal, quote.currency), COL.total, titleY, { width: RIGHT - COL.total, align: "right" });

        y = Math.max(bottom, titleY + 14) + 6;
        doc.moveTo(MARGIN, y).lineTo(RIGHT, y).strokeColor(LINE).lineWidth(1).stroke();
        y += 2;

        if (y > 690) { doc.addPage(); y = MARGIN; }
      }

      // ---- Totals (right-aligned key/value) ----
      const subtotal = (quote.materialsServicesSubtotal || 0) + (quote.laborSubtotal || 0);
      y += 8;
      const totalsX = 330;
      const totalRow = (label: string, value: string, bold = false) => {
        doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9.5).fillColor(INK);
        doc.text(label, totalsX, y, { width: 130 });
        doc.text(value, COL.total, y, { width: RIGHT - COL.total, align: "right" });
        y += 16;
        doc.moveTo(totalsX, y - 4).lineTo(RIGHT, y - 4).strokeColor(LINE).lineWidth(0.5).stroke();
      };
      totalRow("Subtotal", money(subtotal, quote.currency), true);
      if (quote.taxOther) totalRow("Tax / Other", money(quote.taxOther, quote.currency), true);
      totalRow("Total", money(quote.total, quote.currency), true);
      totalRow("Net Amount", money(quote.total, quote.currency), true);

      // ---- Signature (left, beside totals) ----
      const sigY = y - 64;
      doc.font("Helvetica").fontSize(9).fillColor(MUTED);
      doc.moveTo(MARGIN, sigY + 30).lineTo(MARGIN + 180, sigY + 30).strokeColor(LINE).lineWidth(1).stroke();
      doc.text("Customer Signature", MARGIN, sigY + 36, { width: 180, align: "center" });

      // ---- Service Summary ----
      y += 18;
      const section = (title: string, body: string) => {
        if (y > 720) { doc.addPage(); y = MARGIN; }
        doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(title, MARGIN, y);
        y = doc.y + 4;
        doc.font("Helvetica").fontSize(9).fillColor("#444444").text(body || "—", MARGIN, y, { width: CONTENT_W });
        y = doc.y + 16;
      };
      const summaryParts = [quote.title, ...(quote.assumptions || [])].filter(Boolean);
      section("Service Summary", summaryParts.join("\n"));
      const terms = (quote.customerNotes && quote.customerNotes.length)
        ? quote.customerNotes.map((n) => `• ${n}`).join("\n")
        : "Should comply with all company policies.";
      section("Terms and Conditions", terms);

      // ---- Footer ----
      doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED)
        .text(`Estimate #${estimateNumber} - (Page 1 of 1)`, MARGIN, 800, { width: CONTENT_W, align: "center" });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
