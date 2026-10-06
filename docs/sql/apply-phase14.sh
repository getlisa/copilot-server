#!/usr/bin/env bash
# Apply docs/sql/phase14.sql to production Aurora — the ServiceTrade integration (servicetrade_* tables,
# quotes.st_* columns, pricebook_source SERVICETRADE).
#
# Run it from the repo root with prod AWS credentials (or from AWS CloudShell after uploading
# phase14.sql, apply-phase14.sh and build-runner.py into one folder):
#     bash docs/sql/apply-phase14.sh
#
# Why a script: Aurora is in a private VPC, so a default CloudShell `psql` times out (seen
# 2026-10-02). A one-off ECS task on the prod image runs inside the VPC, with the RDS master
# credentials attached because `quotes` is owned by `postgres`, not `app_user`. The throwaway
# task-definition revision is DEREGISTERED on exit, including on failure.
#
# ORDER: RUN THIS BEFORE DEPLOYING THE IMAGE THAT USES IT (the copilot-server ServiceTrade PR). Prisma
# SELECTs every scalar column it knows about; an image with the st_* columns against a
# database without them fails EVERY read of `quotes`.
#
# Success marker: PHASE14_APPLIED (derived from the SQL filename by build-runner.py).
set -euo pipefail

export AWS_DEFAULT_REGION=us-east-1
CLUSTER=techcopilot-prod-ecs-cluster
SERVICE=techcopilot-prod-assistant
FAMILY=techcopilot-prod-assistant
CONTAINER=assistant
LOG_GROUP=/ecs/techcopilot-prod-assistant
MASTER_SECRET="arn:aws:secretsmanager:us-east-1:458799594709:secret:rds!cluster-354ddf05-2500-40c0-a536-ab171d0ac675-HGBVkG"
SQL_FILE="$(dirname "$0")/phase14.sql"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[ -f "$SQL_FILE" ] || { echo "missing $SQL_FILE" >&2; exit 1; }

# ---- 1. build ONE self-contained runner, with the statements already split ---------------------
# The split happens HERE, not in the container. Prisma's $executeRawUnsafe takes one statement at
# a time, and a naive split on ";" would cut every DO $$ ... $$ block in half at its first inner
# semicolon — so it needs a dollar-quote-aware splitter, and doing it locally keeps that logic out
# of the payload. Which matters: the ECS container-override limit is 8192 bytes, and an earlier
# version shipped the runner as a tar archive. A tar of one small file is ~10KB before compression
# (512-byte blocks, 10240-byte minimum), so it blew the limit on its own.
python3 "$(dirname "$0")/build-runner.py" "$SQL_FILE" "$WORK/runsql.js"

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
# One gzip+base64 blob, size-checked locally against the 8192-byte override limit — a failure here
# with the actual byte count beats an InvalidParameterException from the API.
PAYLOAD=$(gzip -9c "$WORK/runsql.js" | base64 | tr -d '\n')
CMD="cd /app && echo '$PAYLOAD' | base64 -d | gunzip > /app/runsql.js && node /app/runsql.js"
if [ ${#CMD} -gt 7800 ]; then
  echo "payload is ${#CMD} bytes — over the 8192-byte container-override limit" >&2
  exit 1
fi
echo "payload: ${#CMD} bytes"

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
echo "Phase 14 applied. servicetrade_* tables, quotes.st_* columns and pricebook_source SERVICETRADE exist; merge the copilot-server ServiceTrade PR next."
