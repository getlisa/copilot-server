// One-off dev migration, applied through DATABASE_URL (the app's connection) on purpose:
// prisma migrate/db push read DIRECT_URL, which the duplicated .env entry points at PROD.
// For prod, run this same ALTER via the migration runbook in docs/.
import prisma from "../src/lib/prisma";

async function main() {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE companies ADD COLUMN IF NOT EXISTS proposal_email_template TEXT`
  );
  console.log("companies.proposal_email_template: OK");
  await prisma.$disconnect();
}
main();
