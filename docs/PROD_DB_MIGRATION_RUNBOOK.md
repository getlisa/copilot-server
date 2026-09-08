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

**Apply the DDL BEFORE deploying the code. Always. There is no nullable-column exception.**

This line used to say the opposite — that new nullable columns were safe to add after the deploy
because old code ignores them. That is true of a hand-written query and **false of Prisma**, which
SELECTs every scalar column in the schema. The moment the new client ships, it asks for a column
that does not exist yet and every read of that table 500s until the DDL lands. The reverse order
is the safe one: an old image simply never mentions the new columns.

(The corollary at "Phase 2 / contract" further down is the same rule read backwards — a column the
new code has stopped using can only be DROPPED after that code is live.)

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

## Pending migration: customers + sales tax as entities (2026-09-08)

The entity + `<entity>_qb` architecture. CLARA owns the entity; a sibling `_qb` row holds what
QuickBooks knows about it. Three reasons the split matters: the entity must work for a company
with no accounting integration, a QuickBooks id is only meaningful inside the realm that issued
it, and re-syncing Intuit's data must never be able to lose the record itself.

Supersedes three tables from the 2026-09-07 block — `raw_customer_qb`, `raw_taxcode_qb` and
`raw_taxrate_qb`. They are dropped, not left behind: they carried only re-syncable reference
data, they are one day old, and two tables claiming to hold the same customers is how they drift.
`raw_item_qb` and `raw_account_qb` stay — items already have their entity (`pricebook_items`,
linked through `qbo_item_links`) and accounts have no CLARA-side counterpart.

**Two phases, and the order is the opposite of the usual rule.** Normally the whole block runs
before the image ships, because Prisma selects every scalar column. Here the block also DROPS
`quotes.qbo_customer_id` — which the *currently running* code still selects. Dropping it first
would break every quote read in production.

So: expand, deploy, then contract.

- **Phase 1 (before the deploy)** — create the new tables and add `quotes.customer_id`. Purely
  additive: the running code ignores all of it, and the new code needs the tables to exist the
  moment it starts.
- **Phase 2 (after the deploy is healthy)** — drop the columns and tables nothing reads any more.

### Phase 1 — expand (run before deploying)

```sql
-- Every service-managed table gets the same audit set (architecture, 2026-09-08):
-- is_active (reversible "not in use"), is_deleted (soft delete, so history that points at the
-- row survives), created_at/created_by, updated_at/updated_by. created_by/updated_by are
-- users.id and NULLABLE: ingestion and background work have no acting user to attribute.
CREATE TABLE IF NOT EXISTS public.customers (
  id         SERIAL PRIMARY KEY,
  company_id INT     NOT NULL,
  name       TEXT    NOT NULL,
  email      TEXT,
  phone      TEXT,
  address    TEXT,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by BIGINT,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by BIGINT
);
-- Mirrors QuickBooks' own DisplayName uniqueness, so a name that works here cannot fail there
-- for a reason the technician never saw.
CREATE UNIQUE INDEX IF NOT EXISTS customers_company_id_name_key ON public.customers (company_id, name);

CREATE TABLE IF NOT EXISTS public.customer_qb (
  id           SERIAL PRIMARY KEY,
  customer_id  INT  NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  company_id   INT  NOT NULL,
  realm_id     TEXT NOT NULL,
  qbo_id       TEXT NOT NULL,
  display_name TEXT NOT NULL,
  -- Read-only in QuickBooks: the parent chain joined by colons ("Customer:Job:Sub-job"). It is
  -- what distinguishes two jobs sharing a name under different parents.
  fully_qualified_name TEXT,
  raw          JSONB,
  synced_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  is_deleted   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by   BIGINT,
  updated_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by   BIGINT
);
-- One row per customer per realm: reconnect to a different QuickBooks file and the old row stays
-- inert rather than being overwritten with an id belonging to someone else's books.
CREATE UNIQUE INDEX IF NOT EXISTS customer_qb_customer_id_realm_id_key ON public.customer_qb (customer_id, realm_id);
CREATE UNIQUE INDEX IF NOT EXISTS customer_qb_company_id_realm_id_qbo_id_key ON public.customer_qb (company_id, realm_id, qbo_id);
CREATE INDEX IF NOT EXISTS customer_qb_company_id_realm_id_idx ON public.customer_qb (company_id, realm_id);

CREATE TABLE IF NOT EXISTS public.sales_tax (
  id           SERIAL PRIMARY KEY,
  company_id   INT     NOT NULL,
  name         TEXT    NOT NULL,
  -- "MANUAL" (typed in tax settings) or "QBO" (ingested). Drives the source-of-truth rule: a
  -- company connected to QuickBooks or a CRM takes its tax from that system, so it cannot
  -- create MANUAL rates and cannot use ones created before connecting. Kept, not deleted —
  -- disconnecting restores them, which a delete could not undo.
  source       TEXT    NOT NULL DEFAULT 'MANUAL',
  rate_percent DECIMAL(6,4) NOT NULL,
  is_default   BOOLEAN NOT NULL DEFAULT FALSE,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  is_deleted   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by   BIGINT,
  updated_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by   BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS sales_tax_company_id_name_key ON public.sales_tax (company_id, name);
CREATE INDEX IF NOT EXISTS sales_tax_company_id_is_active_idx ON public.sales_tax (company_id, is_active);
-- At most ONE default per company. Partial unique indexes cannot be expressed in schema.prisma,
-- so this is the only place the rule is enforced by the database — the controller also moves the
-- default inside a transaction. Two defaults would mean a new estimate picking one arbitrarily,
-- and picking arbitrarily in money.
CREATE UNIQUE INDEX IF NOT EXISTS sales_tax_one_default_per_company
  ON public.sales_tax (company_id) WHERE is_default AND NOT is_deleted;

CREATE TABLE IF NOT EXISTS public.sales_tax_qb (
  id           SERIAL PRIMARY KEY,
  sales_tax_id INT  NOT NULL REFERENCES public.sales_tax(id) ON DELETE CASCADE,
  company_id   INT  NOT NULL,
  realm_id     TEXT NOT NULL,
  -- "TaxRate" carries the percentage; "TaxCode" is what a transaction line references. Intuit
  -- models them separately, so one CLARA rate can hold a row of each.
  qbo_type     TEXT NOT NULL,
  qbo_id       TEXT NOT NULL,
  name         TEXT NOT NULL,
  raw          JSONB,
  synced_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  is_deleted   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by   BIGINT,
  updated_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by   BIGINT
);
-- salesTaxId is part of the key on purpose: one QuickBooks rate belongs to MANY codes (a state
-- rate sits in every city group in that state), so a key without it makes the second code's
-- member insert collide with the first's row and abort the entire sync.
-- Name copied verbatim from `prisma migrate diff` — Prisma truncates the derived name to
-- Postgres's 63-byte limit (note the double underscore), and a divergence here is permanent
-- drift in a repo whose only record of production is schema.prisma.
CREATE UNIQUE INDEX IF NOT EXISTS sales_tax_qb_sales_tax_id_company_id_realm_id_qbo_type_qbo__key
  ON public.sales_tax_qb (sales_tax_id, company_id, realm_id, qbo_type, qbo_id);
CREATE INDEX IF NOT EXISTS sales_tax_qb_sales_tax_id_idx ON public.sales_tax_qb (sales_tax_id);

-- Quotes point at the customer ENTITY. The QuickBooks id is not duplicated here — it lives on
-- customer_qb, keyed by realm, so a reconnect cannot leave a stale id attached to an estimate.
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS customer_id INT;
-- The FK schema.prisma already implies (Quote.customer is an optional relation). Safe here
-- because every existing row is NULL, and SET NULL rather than CASCADE: deleting a customer
-- must not delete quotes.
ALTER TABLE public.quotes DROP CONSTRAINT IF EXISTS quotes_customer_id_fkey;
ALTER TABLE public.quotes ADD CONSTRAINT quotes_customer_id_fkey
  FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;

-- NO BACKFILL, deliberately (product, 2026-09-08). Older estimates are not synced: a company
-- with no integration has nothing to carry across, and a company with one gets a per-estimate
-- "Sync to QuickBooks" action beside Send / Download rather than a bulk migration of history.
--
-- The failure this used to guard against is closed in code instead: ensureQboCustomer's legacy
-- branch now REFUSES a quote with no customer name, where it previously created a QuickBooks
-- customer literally called "Customer" in the client's books. Measured 2026-09-08: 0 of 99
-- quotes carry qbo_customer_id and 0 have been posted, so nothing is being abandoned here.

ALTER TABLE public.customers    OWNER TO app_user;
ALTER TABLE public.customer_qb  OWNER TO app_user;
ALTER TABLE public.sales_tax    OWNER TO app_user;
ALTER TABLE public.sales_tax_qb OWNER TO app_user;
GRANT USAGE ON SEQUENCE public.customers_id_seq    TO app_user;
GRANT USAGE ON SEQUENCE public.customer_qb_id_seq  TO app_user;
GRANT USAGE ON SEQUENCE public.sales_tax_id_seq    TO app_user;
GRANT USAGE ON SEQUENCE public.sales_tax_qb_id_seq TO app_user;
```

### Phase 2 — contract (run only once the new image is healthy)

Nothing reads these once the new code is live. Kept separate because the OLD code selects
`qbo_customer_id`, so dropping it before the deploy takes down every quote read.

**This is the point of no return.** Once these columns are dropped the previous image cannot be
rolled back — its Prisma client selects them, so every quote read fails immediately. Roll back
BEFORE running Phase 2. If you must roll back after, re-add the columns
(`ALTER TABLE public.quotes ADD COLUMN qbo_customer_id TEXT; ALTER TABLE public.quotes ADD COLUMN
qbo_customer_name TEXT;`) before scaling the old task definition up.

**"Healthy" means exercised, not just passing a health check.** One quote read and one estimate
posted on the new image — the health endpoint touches neither the new tables nor the QBO path.

**Check what you are dropping.** There is no backfill by design (see Phase 1), so this reports
how many quotes lose a QuickBooks customer link. Those estimates are re-synced on demand from the
estimate screen, not migrated:

```sql
SELECT count(*) FROM public.quotes WHERE qbo_customer_id IS NOT NULL;
```

```sql
ALTER TABLE public.quotes DROP COLUMN IF EXISTS qbo_customer_id;
ALTER TABLE public.quotes DROP COLUMN IF EXISTS qbo_customer_name;

-- Superseded by customers / customer_qb / sales_tax / sales_tax_qb. Reference data only, one day
-- old, and re-syncable — leaving them would leave two tables claiming the same customers.
DROP TABLE IF EXISTS public.raw_customer_qb;
DROP TABLE IF EXISTS public.raw_taxcode_qb;
DROP TABLE IF EXISTS public.raw_taxrate_qb;
```

**Verify the SQL against the schema before running it.** This block is hand-written, so the one
tool that can prove it matches `schema.prisma` is:

```bash
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
```

Compare the statements for the new tables against the block below — index names included. That
comparison is what would have caught the constraint name being 66 bytes (Postgres allows 63) and
the member key missing `sales_tax_id`.

Both phases run as the Aurora master via a one-off ECS task — `app_user` cannot DDL. Recipe in
`docs/qbo/QBO-INTEGRATION.md` §10. Re-sync after the deploy to populate customers and sales tax
(the 2026-09-07 sync wrote to the tables phase 2 removes).

## APPLIED 2026-09-07: QuickBooks reference-data ingestion (2026-09-07)

Five mirror tables for QuickBooks reference data, plus our own item-id mapping. Additive and
idempotent; no existing table or column is touched, so nothing changes behaviour for a company
without a QuickBooks connection.

Naming follows the product convention `raw_<entity>_qb`. These are a CACHE of Intuit's data and
never a source of truth. `qbo_item_links` is deliberately NOT one of them: it records a decision
CLARA made (which QBO item a CLARA item maps to) and must survive any re-sync.

Run this BEFORE the image ships — Prisma selects every scalar column, and
`admin.controller.ts` reads `companies`/`company_configs` with no `select`, so the console 500s
against an unmigrated database.

```sql
CREATE TABLE IF NOT EXISTS public.raw_customer_qb (
  id           SERIAL PRIMARY KEY,
  company_id   INT     NOT NULL,
  qbo_id       TEXT    NOT NULL,
  display_name TEXT    NOT NULL,
  email        TEXT,
  phone        TEXT,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  raw          JSONB   NOT NULL,
  synced_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS raw_customer_qb_company_id_qbo_id_key ON public.raw_customer_qb (company_id, qbo_id);
CREATE INDEX IF NOT EXISTS raw_customer_qb_company_id_display_name_idx ON public.raw_customer_qb (company_id, display_name);

CREATE TABLE IF NOT EXISTS public.raw_item_qb (
  id         SERIAL PRIMARY KEY,
  company_id INT     NOT NULL,
  qbo_id     TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  type       TEXT,
  taxable    BOOLEAN,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  raw        JSONB   NOT NULL,
  synced_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS raw_item_qb_company_id_qbo_id_key ON public.raw_item_qb (company_id, qbo_id);
-- Names are stored casefolded, so this doubles as the case-insensitive lookup.
CREATE UNIQUE INDEX IF NOT EXISTS raw_item_qb_company_id_name_key ON public.raw_item_qb (company_id, name);

CREATE TABLE IF NOT EXISTS public.raw_taxcode_qb (
  id         SERIAL PRIMARY KEY,
  company_id INT     NOT NULL,
  qbo_id     TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  taxable    BOOLEAN NOT NULL DEFAULT TRUE,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  raw        JSONB   NOT NULL,
  synced_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS raw_taxcode_qb_company_id_qbo_id_key ON public.raw_taxcode_qb (company_id, qbo_id);

CREATE TABLE IF NOT EXISTS public.raw_taxrate_qb (
  id         SERIAL PRIMARY KEY,
  company_id INT     NOT NULL,
  qbo_id     TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  rate_value DECIMAL(6,4),
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  raw        JSONB   NOT NULL,
  synced_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS raw_taxrate_qb_company_id_qbo_id_key ON public.raw_taxrate_qb (company_id, qbo_id);

CREATE TABLE IF NOT EXISTS public.raw_account_qb (
  id                SERIAL PRIMARY KEY,
  company_id        INT     NOT NULL,
  qbo_id            TEXT    NOT NULL,
  name              TEXT    NOT NULL,
  account_type      TEXT,
  account_sub_type  TEXT,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  raw               JSONB   NOT NULL,
  synced_at         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS raw_account_qb_company_id_qbo_id_key ON public.raw_account_qb (company_id, qbo_id);
CREATE INDEX IF NOT EXISTS raw_account_qb_company_id_account_type_idx ON public.raw_account_qb (company_id, account_type);

-- OUR mapping, not a mirror. Scoped by realm_id because an item id means nothing outside the
-- QuickBooks company that issued it: reconnect to a different file and the ids are strangers'.
-- Two nullable keys on purpose — Postgres treats NULLs as distinct in a unique index, so a
-- pricebook-keyed row and a name-keyed row never collide. Measured 2026-09-07: 366 of 674 quote
-- lines carry a pricebook_code (zero orphans), 308 do not, including all 65 labor lines.
CREATE TABLE IF NOT EXISTS public.qbo_item_links (
  id                SERIAL PRIMARY KEY,
  company_id        INT     NOT NULL,
  realm_id          TEXT    NOT NULL,
  pricebook_item_id INT,
  item_key          TEXT,
  qbo_item_id       TEXT    NOT NULL,
  created_by_clara  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS qbo_item_links_company_realm_pricebook_key ON public.qbo_item_links (company_id, realm_id, pricebook_item_id);
CREATE UNIQUE INDEX IF NOT EXISTS qbo_item_links_company_realm_itemkey_key ON public.qbo_item_links (company_id, realm_id, item_key);
CREATE INDEX IF NOT EXISTS qbo_item_links_company_realm_idx ON public.qbo_item_links (company_id, realm_id);

-- The QuickBooks customer an estimate bills to, chosen or created on the estimate screen. The
-- customer must exist in QuickBooks (and so have an id) before the estimate is posted; null means
-- nothing has been linked yet and the posting path falls back to matching on the customer name.
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS qbo_customer_id   TEXT;
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS qbo_customer_name TEXT;

-- New tables are created by postgres; hand them to app_user like the rest.
ALTER TABLE public.raw_customer_qb OWNER TO app_user;
ALTER TABLE public.raw_item_qb     OWNER TO app_user;
ALTER TABLE public.raw_taxcode_qb  OWNER TO app_user;
ALTER TABLE public.raw_taxrate_qb  OWNER TO app_user;
ALTER TABLE public.raw_account_qb  OWNER TO app_user;
ALTER TABLE public.qbo_item_links  OWNER TO app_user;
GRANT USAGE ON SEQUENCE public.raw_customer_qb_id_seq TO app_user;
GRANT USAGE ON SEQUENCE public.raw_item_qb_id_seq     TO app_user;
GRANT USAGE ON SEQUENCE public.raw_taxcode_qb_id_seq  TO app_user;
GRANT USAGE ON SEQUENCE public.raw_taxrate_qb_id_seq  TO app_user;
GRANT USAGE ON SEQUENCE public.raw_account_qb_id_seq  TO app_user;
GRANT USAGE ON SEQUENCE public.qbo_item_links_id_seq  TO app_user;
```

`app_user` cannot run this: it is not a superuser, has no CREATE on schema `public`, and the
existing tables are owned by `postgres`. Run it as the Aurora master through a one-off ECS task —
the recipe is in `docs/qbo/QBO-INTEGRATION.md` §10.

## APPLIED 2026-09-04: QuickBooks Online estimate posting (2026-09-02)

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

## APPLIED (date unrecorded): company service address (2026-08-25)

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
