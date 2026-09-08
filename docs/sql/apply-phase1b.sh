#!/usr/bin/env bash
# Apply docs/sql/phase1b.sql to production Aurora.
#
# Why this is a script and not "just run the SQL": Aurora is in a private VPC, so the statements
# have to execute from inside it — a one-off ECS task on the prod image is the only path. And
# `quotes` / `quote_line_items` are owned by `postgres`, not `app_user`, so the task needs the
# RDS master credentials that the service's own task definition does not carry.
#
# Run it from the repo root:
#     bash docs/sql/apply-phase1b.sh
#
# It registers a throwaway task definition with the master credentials attached, runs the
# migration, prints the output, and DEREGISTERS that revision before exiting — including on
# failure. Nothing about the running service is touched.
#
# ORDER: this runs BEFORE the new image ships. Prisma SELECTs every scalar column it knows about,
# so an image that knows `quote_line_items.taxable` asks for it on every quote read and 500s until
# the column exists. An old image simply never mentions the new columns, so this direction is safe.
set -euo pipefail

export AWS_DEFAULT_REGION=us-east-1
CLUSTER=techcopilot-prod-ecs-cluster
SERVICE=techcopilot-prod-assistant
FAMILY=techcopilot-prod-assistant
CONTAINER=assistant
LOG_GROUP=/ecs/techcopilot-prod-assistant
MASTER_SECRET="arn:aws:secretsmanager:us-east-1:458799594709:secret:rds!cluster-354ddf05-2500-40c0-a536-ab171d0ac675-HGBVkG"
SQL_FILE="$(dirname "$0")/phase1b.sql"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[ -f "$SQL_FILE" ] || { echo "missing $SQL_FILE" >&2; exit 1; }

# ---- 1. the runner, which executes the SQL statement by statement -----------------------------
# Prisma's $executeRawUnsafe takes ONE statement at a time, and a naive split on ";" would cut
# every DO $$ ... $$ block in half at its first inner semicolon — hence the dollar-quote-aware
# splitter rather than `sql.split(';')`.
cat > "$WORK/runsql.js" <<'JS'
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');

function statements(sql) {
  const out = [];
  let buf = '', i = 0, tag = null;
  while (i < sql.length) {
    if (!tag) {
      const m = /^\$([A-Za-z_]*)\$/.exec(sql.slice(i));
      if (m) { tag = m[0]; buf += tag; i += tag.length; continue; }
      if (sql[i] === '-' && sql[i + 1] === '-') {
        const nl = sql.indexOf('\n', i);
        i = nl === -1 ? sql.length : nl + 1;
        continue;
      }
      if (sql[i] === ';') { if (buf.trim()) out.push(buf.trim()); buf = ''; i++; continue; }
      buf += sql[i++];
    } else {
      if (sql.startsWith(tag, i)) { buf += tag; i += tag.length; tag = null; continue; }
      buf += sql[i++];
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// The app's own URL points at app_user, which cannot ALTER a postgres-owned table. Swap in the
// master credentials while keeping the host, port and database exactly as configured.
function masterUrl() {
  const u = new URL(process.env.DIRECT_URL || process.env.DATABASE_URL);
  u.username = encodeURIComponent(process.env.PGMASTER_USER);
  u.password = encodeURIComponent(process.env.PGMASTER_PASSWORD);
  return u.toString();
}

(async () => {
  const stmts = statements(fs.readFileSync(process.argv[2], 'utf8'));
  console.log('statements:', stmts.length);
  const url = masterUrl();
  const p = new PrismaClient({ datasources: { db: { url } } });
  for (const [n, s] of stmts.entries()) {
    try {
      await p.$executeRawUnsafe(s);
      console.log(`[${n + 1}/${stmts.length}] ok: ${s.split('\n')[0].slice(0, 90)}`);
    } catch (e) {
      console.error(`[${n + 1}/${stmts.length}] FAILED: ${s.slice(0, 200)}\n  ${e.message}`);
      await p.$disconnect();
      process.exit(1);
    }
  }
  await p.$disconnect();
  console.log('PHASE1B_APPLIED');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
JS

# ---- 2. a task definition that also carries the master credentials -----------------------------
aws ecs describe-task-definition --task-definition "$SERVICE" --query 'taskDefinition' --output json > "$WORK/base.json"
python3 - "$WORK/base.json" "$WORK/new.json" "$MASTER_SECRET" <<'PY'
import json, sys
base, out, master = sys.argv[1], sys.argv[2], sys.argv[3]
td = json.load(open(base))
for k in ("taskDefinitionArn","revision","status","requiresAttributes",
          "compatibilities","registeredAt","registeredBy","deregisteredAt"):
    td.pop(k, None)
c = td["containerDefinitions"][0]
have = {s["name"] for s in c["secrets"]}
for name, key in (("PGMASTER_USER","username"), ("PGMASTER_PASSWORD","password")):
    if name not in have:
        c["secrets"].append({"name": name, "valueFrom": f"{master}:{key}::"})
json.dump(td, open(out, "w"))
print("image:", c["image"])
PY

REV=$(aws ecs register-task-definition --cli-input-json "file://$WORK/new.json" \
        --query 'taskDefinition.revision' --output text)
TASKDEF="$FAMILY:$REV"
echo "registered $TASKDEF (deregistered on exit)"
# Deregister even if the run fails — this revision carries master credentials and must not linger.
trap 'aws ecs deregister-task-definition --task-definition "'"$TASKDEF"'" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

# ---- 3. run it inside the VPC ------------------------------------------------------------------
# gzip+base64: the container-override payload is capped at 8192 bytes and the SQL plus runner is
# comfortably over that.
PAYLOAD=$(tar -czf - -C "$WORK" runsql.js | base64 | tr -d '\n')
SQL_B64=$(gzip -9c "$SQL_FILE" | base64 | tr -d '\n')
CMD="cd /app && echo '$PAYLOAD' | base64 -d | tar -xzf - && echo '$SQL_B64' | base64 -d | gunzip > /app/phase1b.sql && node /app/runsql.js /app/phase1b.sql"

NET=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
        --query 'services[0].networkConfiguration' --output json)
OVERRIDES=$(python3 -c '
import json, sys
print(json.dumps({"containerOverrides":[{"name":sys.argv[1],"command":["/bin/sh","-lc",sys.argv[2]]}]}))
' "$CONTAINER" "$CMD")

TASK_ARN=$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$TASKDEF" --launch-type FARGATE \
             --network-configuration "$NET" --overrides "$OVERRIDES" \
             --query 'tasks[0].taskArn' --output text)
TASK_ID=${TASK_ARN##*/}
echo "task $TASK_ID started; waiting..."
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"

echo "----- output -----"
aws logs get-log-events --log-group-name "$LOG_GROUP" --log-stream-name "ecs/$CONTAINER/$TASK_ID" \
  --start-from-head --query 'events[].message' --output text | tr '\t' '\n'

EXIT_CODE=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
              --query "tasks[0].containers[?name=='$CONTAINER'].exitCode | [0]" --output text)
echo "----- exit code: $EXIT_CODE -----"
[ "$EXIT_CODE" = "0" ] || exit 1
echo "Phase 1b applied. Safe to merge copilot-server#14 now."
