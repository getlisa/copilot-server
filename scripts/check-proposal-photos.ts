import assert from "node:assert";
import { imageDims } from "../src/copilot/estimating/proposalDocx";
import { buildProposalPdf } from "../src/copilot/estimating/proposalPdf";

// PNG: width/height are big-endian u32 at offsets 16/20 of the IHDR chunk.
const png = Buffer.alloc(24);
png.writeUInt32BE(800, 16);
png.writeUInt32BE(600, 20);
assert.deepStrictEqual(imageDims(png, "png"), { width: 800, height: 600 });
assert.strictEqual(imageDims(Buffer.alloc(10), "png"), null); // truncated

// JPEG: SOI, an APP0 segment to skip, then SOF0 carrying height/width.
const jpg = Buffer.from([
  0xff, 0xd8, // SOI
  0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0, length 4 (2 payload bytes)
  0xff, 0xc0, 0x00, 0x11, 0x08, // SOF0, length, precision
  0x04, 0x00, // height 1024
  0x03, 0x00, // width 768
  0x00, 0x00, 0x00, 0x00, // padding so the scan window fits
]);
assert.deepStrictEqual(imageDims(jpg, "jpg"), { width: 768, height: 1024 });
assert.strictEqual(imageDims(Buffer.from([0xff, 0xd8, 0x00, 0x00]), "jpg"), null); // no SOF

// PDF proposal renders end-to-end (no photos — those need S3) and is a real PDF.
buildProposalPdf({
  header: {
    companyName: "Test Co",
    companyAddress: "1 Main St",
    companyPhone: "555-0100",
    companyEmail: "test@example.com",
    customerName: "Customer",
    billingAddress: "2 Oak Ave",
    serviceAddress: "",
    technicianName: "Tech",
    logoUrl: null,
    licenseNumber: "LIC-1",
  },
  projectTitle: "Check",
  date: new Date("2026-01-01"),
  scopeSections: [{ title: "Scope", bullets: ["do the work"] }],
  total: 1825,
  optionTotals: [{ name: "Option A", total: 100, combinedTotal: 1925 }],
  unpricedCount: 1,
}).then((pdf) => {
  assert.ok(pdf.subarray(0, 5).toString() === "%PDF-", "PDF magic bytes");
  assert.ok(pdf.length > 2000, "PDF has content");
  console.log("check-proposal-photos: OK");
});
