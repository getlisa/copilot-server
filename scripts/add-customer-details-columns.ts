// One-off migration for the customer-details + image-attachment PRD, batched into ONE run so
// the prod privilege-escalation dance (see below) happens once, not twice:
//
//   - quotes.customer_name / customer_address / customer_phone — nullable text, free text with
//     NO format validation (PRD is explicit). Additive and nullable, so safe on a live DB and
//     safe to run twice. No existing quote changes: null renders blank/omitted everywhere.
//   - image_files.message_id → NULLABLE — an image attached directly to a quote (estimator
//     attach action) has no carrier chat message. Dropping NOT NULL breaks nothing: every
//     existing row keeps its message_id, and the FK stays.
//
// It MUST be applied BEFORE the server image that reads the customer columns deploys — Prisma
// selects them on every quote query, so deploying first breaks the whole quotes API.
//
// THIS CANNOT RUN AS THE APPLICATION USER — same wall as add-markup-columns.ts (42501: must be
// owner of table; tables owned by `postgres`, app connects as `app_user`, both URLs in .env are
// the same user). Run it as the Aurora master (`postgres`) from INSIDE the VPC via a one-off
// `aws ecs run-task` against techcopilot-prod-assistant with DATABASE_URL overridden to the
// master credential (RDS-managed secret rds!cluster-354ddf05-2500-40c0-a536-ab171d0ac675).
// Full sequence, including the IAM grant + revert, is documented in
// docs/MARKUP_CUSTOMER_DETAILS_PLAN.md §1.
import prisma from "../src/lib/prisma";

async function main() {
  for (const col of ["customer_name", "customer_address", "customer_phone"]) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE quotes ADD COLUMN IF NOT EXISTS ${col} TEXT`
    );
    console.log(`quotes.${col}: OK`);
  }

  await prisma.$executeRawUnsafe(
    `ALTER TABLE image_files ALTER COLUMN message_id DROP NOT NULL`
  );
  console.log("image_files.message_id nullable: OK");

  // The columns are new, so every quote must read back null — a non-null here means the
  // script ran before and data exists; either is fine, but say so instead of assuming.
  const [{ quotes, withCustomer }] = await prisma.$queryRawUnsafe<
    { quotes: bigint; withCustomer: bigint }[]
  >(
    `SELECT COUNT(*) AS "quotes",
            COUNT(*) FILTER (WHERE customer_name IS NOT NULL
                                OR customer_address IS NOT NULL
                                OR customer_phone IS NOT NULL) AS "withCustomer"
       FROM quotes`
  );
  console.log(`\nquotes: ${quotes}, with any customer field set: ${withCustomer}`);

  await prisma.$disconnect();
}

main();
