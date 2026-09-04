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

## Pending migration: QuickBooks Online estimate posting (2026-09-02)

One table for per-company QBO OAuth connections plus the posted-estimate id on quotes.
Additive and idempotent; run via step 4 above, BEFORE deploying the code that ships it —
Prisma selects all scalar columns, so every `quotes` read fails while the column is absent.
Deliberately NOT crm_connections: that table belongs to the platform backend, is capped at
one connection per company, and extending its provider enum breaks that service's client.

```sql
-- Per-company QuickBooks OAuth tokens. Clara owns the Intuit app, so the app keys live in server
-- env (QBO_CLIENT_ID / QBO_CLIENT_SECRET) and NOT in this table; the row is created by the OAuth
-- callback. Connected = encrypted_auth non-null AND environment matches the server's
-- QBO_ENVIRONMENT (Intuit issues separate Development/Production keysets, so tokens do not
-- survive an environment flip — a mismatch means "reconnect", not a silent 401).
--
-- Revised 2026-09-04: client_id / encrypted_client_secret were in the earlier draft of this block
-- (per-company Intuit apps, now deferred — see the header of src/lib/qbo.ts). If an earlier
-- version of this block was ALREADY run anywhere, CREATE TABLE IF NOT EXISTS is a no-op there and
-- the old NOT NULL client_id would reject every callback insert, so the DROPs below are required,
-- not defensive dressing.
CREATE TABLE IF NOT EXISTS public.qbo_connections (
  id                      SERIAL PRIMARY KEY,
  company_id              INT NOT NULL,
  environment             TEXT NOT NULL DEFAULT 'production',
  realm_id                TEXT,
  encrypted_auth          TEXT,
  access_token_expires_at TIMESTAMP(3),
  created_at              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE public.qbo_connections DROP COLUMN IF EXISTS client_id;
ALTER TABLE public.qbo_connections DROP COLUMN IF EXISTS encrypted_client_secret;
CREATE UNIQUE INDEX IF NOT EXISTS qbo_connections_company_id_key ON public.qbo_connections (company_id);
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS qbo_estimate_id TEXT;
-- Completion-time option choice (QBO PRD US3); cleared on reopen.
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS chosen_option_group TEXT;
-- Per-line QBO item selection (QBO PRD US5); null = auto match/create by name at post time.
ALTER TABLE public.quote_line_items ADD COLUMN IF NOT EXISTS qbo_item_id TEXT;
ALTER TABLE public.quote_line_items ADD COLUMN IF NOT EXISTS qbo_item_name TEXT;
-- Company default markup for NEW quotes (QBO PRD US7).
ALTER TABLE public.company_configs ADD COLUMN IF NOT EXISTS default_markup_percent DECIMAL(5,2) NOT NULL DEFAULT 0;

-- New table is created by postgres; hand it to app_user like the rest.
ALTER TABLE public.qbo_connections OWNER TO app_user;
GRANT USAGE ON SEQUENCE public.qbo_connections_id_seq TO app_user;
```

Also required on the LOCAL dev database (Supabase) — run the same block there by hand.
Do NOT use `prisma db push` for it: the duplicate `DIRECT_URL` in local `.env` makes the
Prisma CLI target prod.

## Pending migration: company service address (2026-08-25)

Registration now captures a billing AND a service address; `companies.address` stays the
billing/mailing address, the new JSONB column holds the service location. Additive and
idempotent; run via step 4 above. MUST be applied before deploying the code that ships it —
Prisma selects all scalar columns, so every `companies` read fails while the column is absent.

```sql
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS service_address JSONB;
```

## APPLIED 2026-08-25: per-client pricebooks, templates, labor rates (2026-08-18)

Run against prod on 2026-08-25 and verified (all expected columns/tables present). Kept for
reference. **Do NOT re-run the `hd_fallback_enabled` UPDATE below once any client has
deliberately opted out** — it cannot tell an opt-out from the old default and would silently
switch them back on. Everything else is idempotent and safe to re-run.

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
-- DEFAULT true (PM decision 2026-08-21): the HD fallback is pre-existing behavior for every
-- client; the column exists to opt a client OUT. A false default would silently unprice
-- every current client's pricebook misses on deploy.
ALTER TABLE public.company_configs  ADD COLUMN IF NOT EXISTS hd_fallback_enabled BOOLEAN NOT NULL DEFAULT true;
-- The two statements below are REQUIRED on any environment where an earlier run of this
-- runbook already created the column with DEFAULT false: ADD COLUMN IF NOT EXISTS is then a
-- no-op, so neither the default nor the already-written false rows get corrected. Harmless
-- where the column is new (default is already true, no row says false).
--
-- ONE-TIME ONLY. The UPDATE cannot distinguish "false because it was the old default" from
-- "false because someone deliberately opted this client out", and today no deliberate opt-out
-- exists (the feature is unreleased). Once real opt-outs exist, DROP THE UPDATE — re-running
-- it would silently switch those clients back on.
ALTER TABLE public.company_configs  ALTER COLUMN hd_fallback_enabled SET DEFAULT true;
UPDATE public.company_configs       SET hd_fallback_enabled = true WHERE hd_fallback_enabled = false;
ALTER TABLE public.companies        ADD COLUMN IF NOT EXISTS website VARCHAR(300);
ALTER TABLE public.companies        ADD COLUMN IF NOT EXISTS footer_terms TEXT;
ALTER TABLE public.companies        ADD COLUMN IF NOT EXISTS proposal_template JSONB;
-- Belt-and-braces (2026-08-25): these two are in schema.prisma but were absent from this
-- block; they may already exist in prod from an earlier hand-run migration — IF NOT EXISTS
-- makes them free either way. The verification step below proves the final state.
ALTER TABLE public.companies        ADD COLUMN IF NOT EXISTS proposal_email_template TEXT;
ALTER TABLE public.quote_line_items ADD COLUMN IF NOT EXISTS search_term TEXT;
ALTER TABLE public.quotes           ADD COLUMN IF NOT EXISTS template_id INT;
ALTER TABLE public.quotes           ADD COLUMN IF NOT EXISTS labor_asked BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.quote_line_items ADD COLUMN IF NOT EXISTS source_pricebook_id INT;
-- NOTE: no price_confirmed column — the fallback-price confirm step was cut before release
-- (owner decision 2026-08-24 overriding pricebook PRD US6; the source label is the disclosure).
-- NOTE: there is deliberately no `labor` column. quote_line_items.is_labor (already in prod
-- since the markup migration) is the single labor flag; a second column meant the markup
-- exemption and the labor flow could disagree.
ALTER TABLE public.quote_line_items ADD COLUMN IF NOT EXISTS labor_rate_id INT;

-- New tables are created by postgres; hand them to app_user like the rest (see below).
ALTER TABLE public.pricebooks      OWNER TO app_user;
ALTER TABLE public.labor_rates     OWNER TO app_user;
ALTER TABLE public.quote_templates OWNER TO app_user;
GRANT USAGE ON SEQUENCE public.pricebooks_id_seq, public.labor_rates_id_seq, public.quote_templates_id_seq TO app_user;
```

### Verify this migration (inside the container, after step 4)

Prints any expected column or table that is still missing — empty output means done:

```bash
node -e "
const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();
const cols={companies:['website','footer_terms','proposal_template','proposal_email_template','service_address'],
 company_configs:['hd_fallback_enabled'],
 quotes:['template_id','labor_asked'],
 quote_line_items:['source_pricebook_id','labor_rate_id','search_term','is_labor'],
 pricebook_items:['pricebook_id']};
const tables=['pricebooks','labor_rates','quote_templates'];
(async()=>{
 for(const[t,cs]of Object.entries(cols)){
  const r=await p.\$queryRawUnsafe(\"select column_name from information_schema.columns where table_name='\"+t+\"'\");
  const have=new Set(r.map(x=>x.column_name));
  cs.filter(c=>!have.has(c)).forEach(c=>console.log('MISSING column',t+'.'+c));
 }
 const r=await p.\$queryRawUnsafe(\"select table_name from information_schema.tables where table_schema='public'\");
 const have=new Set(r.map(x=>x.table_name));
 tables.filter(t=>!have.has(t)).forEach(t=>console.log('MISSING table',t));
 console.log('verification done');process.exit(0)})();
"
```

## Table ownership (optional cleanup)

Tables are owned by `postgres`, so every DDL needs the master secret. If you'd rather let
`app_user` run its own migrations (trade-off: the app credential can then alter schema):

```sql
ALTER TABLE public.quote_line_items OWNER TO app_user;  -- per table, as postgres
```
