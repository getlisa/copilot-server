# Prod DB Migration Runbook

How to apply a schema change to the **production Aurora** database. This project has no
`prisma/migrations/` directory — schema changes ship as hand-run SQL. Written after the
`option_group` column migration (2026-08-14), including every failure hit along the way.

## The environment

| Thing | Value |
|---|---|
| Prod DB | Aurora Postgres, **private VPC** (`techcopilot-prod-aurora-aurorawriterinstance-hn0gslosol82.c2vcwaueofxu.us-east-1.rds.amazonaws.com:5432/techcopilot`) |
| App DB user | `app_user` — data only, **cannot run DDL** (tables are owned by `postgres`) |
| Master credentials | Secrets Manager: `rds!cluster-354ddf05-2500-40c0-a536-ab171d0ac675` (RDS-managed, `{username, password}`) |
| ECS cluster | `techcopilot-prod-ecs-cluster` |
| ECS service | `techcopilot-prod-assistant` |
| Local `.env` DATABASE_URLs | Supabase (dev/staging) — **NOT prod**. Prod is the Aurora URL above. |

## Process

### 1. Code side (before deploy)

```bash
# edit prisma/schema.prisma, then:
npx prisma generate      # local only, no DB connection — regenerates client types
npm test                 # typecheck + regression checks
```

Deploy the code. New nullable columns are safe to add after deploy (old code ignores them);
anything the old code would break on must be applied before the deploy instead.

### 2. Get a shell inside the prod VPC

Default CloudShell **cannot reach the DB** — the hostname resolves to a private IP
(`10.0.x.x`) and times out. Two options:

**A. ECS Exec into the running app container** (preferred — it has the VPC, the env, and Prisma):

```bash
CLUSTER=techcopilot-prod-ecs-cluster
SERVICE=techcopilot-prod-assistant
TASK=$(aws ecs list-tasks --cluster $CLUSTER --service-name $SERVICE --query 'taskArns[0]' --output text)

# container name + confirm exec is enabled
aws ecs describe-tasks --cluster $CLUSTER --tasks "$TASK" \
  --query 'tasks[0].{containers: containers[].name, execEnabled: enableExecuteCommand}'

aws ecs execute-command --cluster $CLUSTER --task "$TASK" \
  --container <container-name> --interactive --command "/bin/sh"
```

If `execEnabled` is `false`: `aws ecs update-service --cluster $CLUSTER --service $SERVICE
--enable-execute-command --force-new-deployment`, or use option B.

**B. CloudShell VPC environment**: CloudShell console → Actions → *Create VPC environment* →
same VPC + a private subnet as Aurora, attach the ECS task security group (it's allowed on
5432). Then plain `psql` works.

### 3. Get the master password (from CloudShell, not the container)

```bash
# NOTE the single quotes — the secret id contains "!", which bash history-expands unquoted
aws secretsmanager get-secret-value \
  --secret-id 'rds!cluster-354ddf05-2500-40c0-a536-ab171d0ac675' \
  --query SecretString --output text
```

### 4. Run the SQL (inside the container)

`prisma db execute` runs exactly the statement you give it — none of the full-schema-sync
risk of `prisma db push`, which will fight (or revert) any drift between prod and
`schema.prisma`. Never run `db push` against prod.

```bash
echo 'ALTER TABLE public.quote_line_items ADD COLUMN IF NOT EXISTS option_group TEXT;' \
  | npx prisma db execute --stdin \
    --url 'postgresql://postgres:<URL-ENCODED-PASSWORD>@techcopilot-prod-aurora-aurorawriterinstance-hn0gslosol82.c2vcwaueofxu.us-east-1.rds.amazonaws.com:5432/techcopilot'
```

- **Silent exit = success.**
- The master password must be **URL-encoded** in the connection string
  (`:`→`%3A` `#`→`%23` `?`→`%3F` `]`→`%5D` `*`→`%2A` `@`→`%40` `/`→`%2F`), and the whole
  URL single-quoted for the shell.
- Must run as `postgres` — the container's own `DATABASE_URL` is `app_user`, which fails
  with `ERROR: must be owner of table ...`.
- Prefer idempotent SQL (`IF NOT EXISTS` / `IF EXISTS`) so a re-run is harmless.

### 5. Verify as the app user (inside the container)

`prisma db execute` can't print SELECT results; use the app's own client:

```bash
node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.\$queryRaw\`select column_name from information_schema.columns where table_name='quote_line_items' and column_name='option_group'\`.then(r=>{console.log(r);process.exit(0)})"
```

### 6. Rotate the master secret (the password passed through terminals/chat)

```bash
aws secretsmanager rotate-secret --secret-id 'rds!cluster-354ddf05-2500-40c0-a536-ab171d0ac675'
```

Zero-risk to the app — it connects as `app_user`, not `postgres`.

## Gotchas hit on 2026-08-14, so you don't hit them again

| Symptom | Cause / fix |
|---|---|
| `psql: invalid URI query parameter: "connection_limit"` | `connection_limit` is Prisma-only — strip the query string for psql |
| `connection ... timed out` from CloudShell | DB is in a private VPC — use ECS Exec or a CloudShell VPC environment (step 2) |
| `bash: !cluster: event not found` | `!` in the secret id triggers history expansion — single-quote it |
| `ERROR: must be owner of table ...` | `app_user` can't DDL — run as `postgres` from the managed secret (steps 3–4) |
| Connection string auth fails with correct password | Password has `: # ? ] *` etc. — URL-encode it (step 4) |
| Which DB is prod? | NOT the Supabase URLs in local `.env` — prod is the Aurora us-east-1 instance |

## Pending migration: per-client pricebooks, templates, labor rates (2026-08-18)

Schema for the pricebook-template-config PRD + labor-charges PRD. All idempotent; run via
step 4 above. New nullable columns and new tables are safe to apply before OR after the code
deploy (old code ignores them); the `NOT NULL DEFAULT` columns are also safe — Postgres 11+
fills them without a table rewrite.

```sql
CREATE TABLE IF NOT EXISTS public.pricebooks (
  id                SERIAL PRIMARY KEY,
  company_id        INT NOT NULL,
  name              TEXT NOT NULL,
  priority          INT NOT NULL,
  source_format     TEXT,
  original_filename TEXT,
  created_at        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS pricebooks_company_id_name_key ON public.pricebooks (company_id, name);
CREATE INDEX IF NOT EXISTS pricebooks_company_id_idx ON public.pricebooks (company_id);

CREATE TABLE IF NOT EXISTS public.labor_rates (
  id          SERIAL PRIMARY KEY,
  company_id  INT NOT NULL,
  name        TEXT NOT NULL,
  hourly_rate DECIMAL(12,2) NOT NULL,
  created_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS labor_rates_company_id_name_key ON public.labor_rates (company_id, name);
CREATE INDEX IF NOT EXISTS labor_rates_company_id_idx ON public.labor_rates (company_id);

CREATE TABLE IF NOT EXISTS public.quote_templates (
  id         SERIAL PRIMARY KEY,
  company_id INT NOT NULL,
  name       TEXT NOT NULL,
  renderer   TEXT NOT NULL DEFAULT 'invoice',
  config     JSONB NOT NULL DEFAULT '{}',
  is_active  BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS quote_templates_company_id_idx ON public.quote_templates (company_id);

ALTER TABLE public.pricebook_items  ADD COLUMN IF NOT EXISTS pricebook_id INT;
CREATE INDEX IF NOT EXISTS pricebook_items_pricebook_id_idx ON public.pricebook_items (pricebook_id);
ALTER TABLE public.company_configs  ADD COLUMN IF NOT EXISTS hd_fallback_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.companies        ADD COLUMN IF NOT EXISTS website VARCHAR(300);
ALTER TABLE public.companies        ADD COLUMN IF NOT EXISTS footer_terms TEXT;
ALTER TABLE public.quotes           ADD COLUMN IF NOT EXISTS template_id INT;
ALTER TABLE public.quotes           ADD COLUMN IF NOT EXISTS labor_asked BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.quote_line_items ADD COLUMN IF NOT EXISTS source_pricebook_id INT;
ALTER TABLE public.quote_line_items ADD COLUMN IF NOT EXISTS price_confirmed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.quote_line_items ADD COLUMN IF NOT EXISTS labor BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.quote_line_items ADD COLUMN IF NOT EXISTS labor_rate_id INT;

-- New tables are created by postgres; hand them to app_user like the rest (see below).
ALTER TABLE public.pricebooks      OWNER TO app_user;
ALTER TABLE public.labor_rates     OWNER TO app_user;
ALTER TABLE public.quote_templates OWNER TO app_user;
GRANT USAGE ON SEQUENCE public.pricebooks_id_seq, public.labor_rates_id_seq, public.quote_templates_id_seq TO app_user;
```

## Table ownership (optional cleanup)

Tables are owned by `postgres`, so every DDL needs the master secret. If you'd rather let
`app_user` run its own migrations (trade-off: the app credential can then alter schema):

```sql
ALTER TABLE public.quote_line_items OWNER TO app_user;  -- per table, as postgres
```
