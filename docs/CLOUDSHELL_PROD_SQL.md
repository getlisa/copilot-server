# Applying SQL to prod Aurora from CloudShell

Steps for running a `docs/sql/*.sql` migration against production from AWS CloudShell —
the replacement for the old "prisma db push from CloudShell" habit. Worked example: **phase4**
(proposal template library).

## Why not `prisma db push` anymore

The old flow (schema.prisma + `npx prisma db push` from CloudShell) is **unsafe on this
database** since the QBO work, for three reasons:

1. The DB deliberately diverges from `schema.prisma` in ways Prisma cannot express: the
   `customers` unique key is `NULLS NOT DISTINCT`, and `sales_tax` / `proposal_templates`
   each carry a partial unique index (one default per company). `db push` can't create them —
   and worse, it reconciles the DB **toward** the schema, so it can rebuild or drop exactly
   these indexes because they don't match what the schema declares.
2. Migrations now include **data steps** (phase4 migrates each company's existing proposal
   design into a `Default` row). `db push` only ever does DDL.
3. There's also a local-env footgun: the duplicate `DIRECT_URL` in `.env` points the Prisma
   CLI at prod even when you think you're on dev. Never run `prisma db push` / `prisma migrate`
   against this schema from anywhere.

All prod DDL is hand-run SQL from `docs/sql/`, written idempotent so a re-run is harmless.

## Steps

### 0. Prerequisites (once)

- CloudShell must reach Aurora, which lives in a **private VPC**. The default CloudShell
  environment has no route to it: create a **VPC environment** (CloudShell → Actions →
  "Create VPC environment") in Aurora's VPC, a private subnet, and a security group the DB's
  security group accepts on 5432. Region: **us-east-1**.
- Your IAM user needs `secretsmanager:GetSecretValue` on the RDS master secret and read
  access to RDS.

### 1. Open CloudShell (VPC environment, us-east-1) and install psql

```bash
sudo dnf install -y postgresql16   # or postgresql15/17, whichever the repo offers
```

### 2. Get the connection pieces

`quotes` is owned by `postgres`, not `app_user`, so DDL on it needs the **master**
credentials (same secret `docs/sql/apply-phase*.sh` uses):

```bash
# username + password
aws secretsmanager get-secret-value \
  --secret-id 'arn:aws:secretsmanager:us-east-1:458799594709:secret:rds!cluster-354ddf05-2500-40c0-a536-ab171d0ac675-HGBVkG' \
  --query SecretString --output text

# writer endpoint
aws rds describe-db-clusters \
  --query 'DBClusters[].{id:DBClusterIdentifier,endpoint:Endpoint}' --output table
```

The database name is the one in the app's `DATABASE_URL` (ECS task definition
`techcopilot-prod-assistant` → secrets/environment).

### 3. Upload the SQL file

CloudShell → Actions → **Upload file** → pick `docs/sql/phase4.sql` from your machine.

### 4. Run it

```bash
psql "host=<WRITER_ENDPOINT> dbname=<DB_NAME> user=<MASTER_USER> password=<MASTER_PASSWORD> sslmode=require" \
  -v ON_ERROR_STOP=1 -f phase4.sql
```

`ON_ERROR_STOP=1` so a failure halts instead of half-applying silently. The phase files are
idempotent — re-running after a fix is safe.

### 5. Verify, in the same psql session

```sql
-- the table and the partial index
\d proposal_templates
SELECT indexname FROM pg_indexes WHERE tablename = 'proposal_templates';
-- expect: idx_proposal_templates_company, proposal_templates_one_default_per_company

-- the new quote columns
SELECT column_name FROM information_schema.columns
WHERE table_name = 'quotes' AND column_name IN ('proposal_template_id', 'template_asked');

-- the data migration: one 'Default' row per company that had a design
SELECT count(*) FROM proposal_templates;
SELECT count(*) FROM companies WHERE proposal_template IS NOT NULL;  -- must match
```

After the next deploy, also run the app-role verification snippet from
`PROD_DB_MIGRATION_RUNBOOK.md` (phase4 section) inside the container — ownership and grants
are what differ between the migration role and `app_user`.

### 6. Record it

Retitle the runbook's `## Pending migration: proposal template library — phase4` section to
`## APPLIED <date>: …` immediately. There is no migration ledger — merged ≠ applied.

## Order rule (applies to phase4)

**The SQL runs BEFORE the image that reads it deploys.** Prisma selects every scalar column
it knows about, so a new client against an unmigrated DB 500s on every quote read. Deploying
the image first is an outage, not a degraded feature.

## Alternative

`bash docs/sql/apply-phase4.sh` does the same thing without CloudShell: a one-off ECS task on
the prod image with the master secret attached, auto-deregistered on exit. Use whichever is
less friction — never both halves of a migration split across the two methods.
