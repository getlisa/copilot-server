/**
 * Reset company 1's jobs to a fresh set of fire-service jobs (technician = user 2).
 *
 * ⚠ DESTRUCTIVE — deleting jobs CASCADES (Postgres ON DELETE CASCADE) to each job's
 * conversations → messages → image files / tool calls, and visit sessions →
 * transcription sessions → transcript turns / audio files, plus visit metrics.
 *
 * Dry-run by default (prints the blast radius + proposed jobs, no writes).
 * Pass --confirm to actually delete + insert.
 *
 *   DRY RUN:  DATABASE_URL=<url> npx tsx scripts/seed-fire-jobs.ts
 *   APPLY:    DATABASE_URL=<url> npx tsx scripts/seed-fire-jobs.ts --confirm
 *
 * DATABASE_URL must point at the intended database (the script prints the host so you
 * can confirm before applying).
 */
import "dotenv/config";
import prisma from "../src/lib/prisma";

const COMPANY_ID = 1;
const TECHNICIAN_ID = 2n;
const CONFIRM = process.argv.includes("--confirm");
const DAY_MS = 24 * 60 * 60 * 1000;

/** Show protocol/host/db only — never credentials. */
function sanitizeDbUrl(raw?: string): string {
  if (!raw) return "(DATABASE_URL not set)";
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

const FIRE_JOBS: { job_target_name: string; address: string; description: string }[] = [
  { job_target_name: "Riverside Tower — Bronx", address: "1230 Grand Concourse, Bronx, NY 10456", description: "Annual wet sprinkler system inspection (NFPA 25): gauges, OS&Y, FDC, alarm valve, main drain test." },
  { job_target_name: "Brooklyn Loft Lofts", address: "55 Washington Ave, Brooklyn, NY 11205", description: "Replace painted-over pendant sprinkler heads in renovated units (NFPA 25 non-compliance)." },
  { job_target_name: "Midtown Office Plaza", address: "405 Lexington Ave, New York, NY 10174", description: "Fire alarm panel showing ground fault on SLC loop 2 — trace and repair, two detectors in trouble." },
  { job_target_name: "Harlem Grill", address: "2110 Frederick Douglass Blvd, New York, NY 10026", description: "Semi-annual kitchen hood suppression service (Ansul R-102): nozzle caps, fusible links, trip test." },
  { job_target_name: "Queens Logistics Warehouse", address: "31-00 47th Ave, Long Island City, NY 11101", description: "Annual fire pump test (NFPA 25 Ch.8): churn, rated and 150% flow, log curve." },
  { job_target_name: "Hudson Medical Center", address: "210 W 31st St, New York, NY 10001", description: "Annual RPZ backflow preventer test and certification, submit to AHJ." },
  { job_target_name: "Lower East Side Apartments", address: "88 Rivington St, New York, NY 10002", description: "Replace failed addressable smoke detectors on existing bases; central station notification." },
  { job_target_name: "Financial District High-Rise", address: "120 Broadway, New York, NY 10271", description: "Standpipe 5-year hydrostatic test (NFPA 25): 200psi for 2 hours, Class I system." },
  { job_target_name: "SoHo Retail Center", address: "560 Broadway, New York, NY 10012", description: "Annual portable extinguisher service (multi-unit): inspect, tag, check 6-year/12-year due." },
  { job_target_name: "Staten Island Cold Storage", address: "1100 South Ave, Staten Island, NY 10314", description: "Dry pipe valve service and trip test; verify air pressure and priming water; reset." },
  { job_target_name: "Chelsea Gallery", address: "525 W 22nd St, New York, NY 10011", description: "Repair active leak at threaded fitting on wet system — drain-down, repair, restore, main drain test." },
  { job_target_name: "Williamsburg Mixed-Use", address: "300 Kent Ave, Brooklyn, NY 11249", description: "Fire alarm acceptance test for new install — full functional test with AHJ witness." },
];

async function main() {
  console.log("──────────────────────────────────────────────");
  console.log("DB:    ", sanitizeDbUrl(process.env.DATABASE_URL));
  console.log("MODE:  ", CONFIRM ? "APPLY (--confirm) — WILL DELETE + INSERT" : "DRY RUN (no changes)");
  console.log("Target: company_id =", COMPANY_ID, "| technician_id =", TECHNICIAN_ID.toString());
  console.log("──────────────────────────────────────────────");

  // Preflight: required rows must exist.
  const company = await prisma.companies.findUnique({ where: { id: COMPANY_ID } });
  if (!company) throw new Error(`Company ${COMPANY_ID} not found — aborting.`);
  const tech = await prisma.users.findUnique({ where: { id: TECHNICIAN_ID } });
  if (!tech) throw new Error(`Technician user ${TECHNICIAN_ID} not found — aborting (job FK would fail).`);
  console.log(`Company:    #${company.id} ${company.name}`);
  console.log(`Technician: #${tech.id} ${tech.first_name} ${tech.last_name} (${tech.email})`);

  // Blast radius.
  const existingJobs = await prisma.jobs.findMany({ where: { company_id: COMPANY_ID }, select: { id: true } });
  const jobIds = existingJobs.map((j) => j.id);
  const convCount = jobIds.length
    ? await prisma.conversation.count({ where: { jobId: { in: jobIds } } })
    : 0;
  console.log(`\nWill DELETE ${jobIds.length} existing job(s) for company ${COMPANY_ID}.`);
  console.log(`  ↳ cascade also deletes ${convCount} conversation(s) on those jobs (+ their messages,`);
  console.log(`    image files, tool calls, visit sessions, transcripts, audio, and metrics).`);
  console.log(`Will INSERT ${FIRE_JOBS.length} new fire-service job(s).`);

  if (!CONFIRM) {
    console.log("\nProposed new jobs:");
    FIRE_JOBS.forEach((j, i) => console.log(`  ${String(i + 1).padStart(2)}. ${j.job_target_name} — ${j.address}`));
    console.log("\n⚠ DRY RUN — no changes made. Re-run with --confirm to apply.");
    return;
  }

  const base = Date.now();
  const data = FIRE_JOBS.map((j, i) => ({
    company_id: COMPANY_ID,
    technician_id: TECHNICIAN_ID,
    start_timestamp: new Date(base + (i + 1) * 2 * DAY_MS),
    address: j.address,
    job_target_name: j.job_target_name,
    description: j.description,
    // status omitted → DB default "scheduled"
  }));

  const result = await prisma.$transaction(async (tx) => {
    const del = await tx.jobs.deleteMany({ where: { company_id: COMPANY_ID } });
    const ins = await tx.jobs.createMany({ data });
    return { deleted: del.count, inserted: ins.count };
  });

  console.log(`\n✓ Deleted ${result.deleted} job(s); inserted ${result.inserted}.`);
  const after = await prisma.jobs.findMany({
    where: { company_id: COMPANY_ID },
    select: { id: true, job_target_name: true, technician_id: true, status: true },
    orderBy: { id: "asc" },
  });
  console.log(`Company ${COMPANY_ID} now has ${after.length} job(s):`);
  after.forEach((j) => console.log(`  #${j.id} ${j.job_target_name} — tech ${j.technician_id}, ${j.status}`));
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error("\n✗ ERROR:", err instanceof Error ? err.message : err);
    await prisma.$disconnect();
    process.exit(1);
  });
