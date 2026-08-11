/**
 * Seed the Estimating Agent's pricebook + knowledge base for a company.
 * Idempotent: upserts pricebook items by (companyId, code) and replaces the
 * company's KB entries. Additive elsewhere — touches nothing but these two tables.
 *
 *   npx tsx scripts/seed-estimating.ts            (company 1)
 *   npx tsx scripts/seed-estimating.ts --company 2
 *
 * Curated subset of docs/EQUIPMENT_DATA.md (fire protection) plus a small
 * electrical set so the PRD's cross-trade examples (wires, switches, panels,
 * Wago connectors) match against the same merged pricebook.
 */
import "dotenv/config";
import prisma from "../src/lib/prisma";

const arg = process.argv.indexOf("--company");
const COMPANY_ID = arg > -1 ? parseInt(process.argv[arg + 1]) : 1;

// [code, description, unit, unitPrice, synonyms]
const PRICEBOOK: [string, string, string, number, string[]][] = [
  // Sprinkler
  ["SP-001", 'Tyco 1/2" Upright Sprinkler Head 155F K=5.6', "EA", 5.25, ["upright head"]],
  ["SP-010", 'Tyco 1/2" Pendant Sprinkler Head 155F K=5.6', "EA", 5.25, ["pendant head", "sprinkler head"]],
  ["SP-020", 'Tyco 1/2" Concealed Pendant Sprinkler Head w/ Plate', "EA", 14.5, ["concealed head"]],
  ["SP-030", 'Tyco 1/2" Sidewall Sprinkler Head 155F', "EA", 7.9, ["sidewall head"]],
  ["PP-001", 'Black Steel Pipe Sch40 1" (10ft stick)', "STICK", 12.5, ["steel pipe"]],
  ["PP-030", 'CPVC BlazeMaster Pipe 3/4" (10ft)', "STICK", 9.2, ["cpvc", "tubing", "tube"]],
  ["VL-001", 'OS&Y Gate Valve 2-1/2"', "EA", 185, ["gate valve"]],
  ["VL-004", 'Butterfly Valve 3" Supervised w/ Tamper', "EA", 142, ["butterfly valve"]],
  ["FD-001", 'Water Flow Switch 1-1/2"', "EA", 48, ["flow switch"]],
  ["FD-008", "Pressure Gauge 0-160psi", "EA", 14.5, ["gauge"]],
  ["BF-002", 'Watts DCVA Backflow Preventer 1"', "EA", 195, ["backflow", "dcva", "irrigation backflow"]],
  ["BF-005", 'Watts RPZ Backflow Preventer 1"', "EA", 380, ["backflow", "rpz"]],
  // Fire alarm
  ["FA-001", "Notifier MS-5 Fire Alarm Panel 3-zone Addressable", "EA", 420, ["fire alarm panel", "facp", "alarm panel"]],
  ["FA-002", "Notifier NFS2-640 Fire Alarm Panel Large", "EA", 2150, ["fire alarm panel large", "bigger panel"]],
  ["FA-010", "Notifier FSP-951 Addressable Photo Smoke Detector", "EA", 52, ["smoke detector", "smoke"]],
  ["FA-030", "Notifier NBG-12LX Manual Pull Station", "EA", 62, ["pull station"]],
  ["FA-040", "System Sensor P2RK Horn Strobe Red 110dB", "EA", 48, ["horn strobe"]],
  ["FA-060", "FPLR Fire Alarm Wire 16AWG 2-cond (1000ft)", "ROLL", 148, ["wire", "wires", "cable"]],
  ["FA-070", "12V 12AH Fire Alarm Battery", "EA", 28, ["battery", "panel battery"]],
  ["EX-003", "Amerex ABC 10lb Fire Extinguisher", "EA", 58, ["extinguisher"]],
  // Electrical (merged pricebook, cross-trade)
  ["EL-001", "THHN Copper Wire 12AWG (100ft)", "ROLL", 32, ["wire", "wires", "electrical wire"]],
  ["EL-002", "Toggle Light Switch 15A Single-Pole", "EA", 4.5, ["switch", "switches", "light switch"]],
  ["EL-003", "Electrical Panel 100A 20-space Load Center", "EA", 185, ["panel", "breaker panel", "electrical panel"]],
  ["EL-004", "Electrical Panel 200A 40-space Load Center", "EA", 320, ["panel", "bigger panel", "large panel"]],
  ["EL-005", "Wago 221 Lever Nut Connector (pack of 10)", "PACK", 8.5, ["wago", "wago connector", "lever nut"]],
  // Labor / services
  ["LB-002", "Labor — Tech II Journeyman (per hour)", "HR", 75, ["labor", "journeyman"]],
  ["SV-020", "Main Drain Flow Test", "EA", 145, ["drain test"]],
  ["SV-040", "Extinguisher Annual Inspection (per unit)", "EA", 18, ["extinguisher inspection"]],
];

// Problem → material associations (assumed taught out-of-band; pre-seeded here).
const KB: {
  problem: string;
  materialDescription: string;
  pricebookCode: string | null;
  defaultQuantity: number;
  unit: string | null;
}[] = [
  {
    problem: "Sprinkler head is old, corroded, or leaking and might need replacing",
    materialDescription: "Pendant sprinkler head (standard 155F)",
    pricebookCode: "SP-010",
    defaultQuantity: 1,
    unit: "EA",
  },
  {
    problem: "Backflow preventer near the irrigation line is noisy or leaking",
    materialDescription: 'DCVA backflow preventer 1"',
    pricebookCode: "BF-002",
    defaultQuantity: 1,
    unit: "EA",
  },
  {
    problem: "Backflow preventer at the main water shutoff is noisy or leaking",
    materialDescription: 'RPZ backflow preventer 1"',
    pricebookCode: "BF-005",
    defaultQuantity: 1,
    unit: "EA",
  },
  {
    problem: "Fire alarm panel shows battery trouble or needs a new battery",
    materialDescription: "12V 12AH fire alarm battery",
    pricebookCode: "FA-070",
    defaultQuantity: 1,
    unit: "EA",
  },
  {
    problem: "Smoke detector chirping, in trouble, or end of life",
    materialDescription: "Addressable photo smoke detector",
    pricebookCode: "FA-010",
    defaultQuantity: 1,
    unit: "EA",
  },
];

async function main() {
  console.log(`Seeding estimating pricebook + KB for company ${COMPANY_ID}…`);
  for (const [code, description, unit, unitPrice, synonyms] of PRICEBOOK) {
    await prisma.pricebookItem.upsert({
      where: { companyId_code: { companyId: COMPANY_ID, code } },
      create: { companyId: COMPANY_ID, code, description, unit, unitPrice, synonyms },
      update: { description, unit, unitPrice, synonyms },
    });
  }
  await prisma.kbEntry.deleteMany({ where: { companyId: COMPANY_ID } });
  await prisma.kbEntry.createMany({
    data: KB.map((k) => ({ ...k, companyId: COMPANY_ID })),
  });
  console.log(`Done: ${PRICEBOOK.length} pricebook items, ${KB.length} KB entries.`);
}

main().finally(() => prisma.$disconnect());
