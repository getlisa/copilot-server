#!/usr/bin/env bash
# Apply docs/sql/phase2.sql to production Aurora.
#
# Why this is a script and not "just run the SQL": Aurora is in a private VPC, so the statements
# have to execute from inside it — a one-off ECS task on the prod image is the only path. And
# `quotes` / `quote_line_items` are owned by `postgres`, not `app_user`, so the task needs the
# RDS master credentials that the service's own task definition does not carry.
#
# Run it from the repo root:
#     bash docs/sql/apply-phase2.sh
#
# It registers a throwaway task definition with the master credentials attached, runs the
# migration, prints the output, and DEREGISTERS that revision before exiting — including on
# failure. Nothing about the running service is touched.
#
# ORDER: this runs only AFTER the new image is live and exercised — the mirror image of Phase 1b.
# A column the new code has stopped using can only be dropped once that code is the one running.
#
# THIS IS THE POINT OF NO RETURN. Dropping quotes.qbo_customer_id makes the previous image
# unrollbackable: its Prisma client SELECTs that column. To roll back afterwards, re-add the two
# columns first (see the header of phase2.sql), THEN scale the old task definition up.
set -euo pipefail

export AWS_DEFAULT_REGION=us-east-1
CLUSTER=techcopilot-prod-ecs-cluster
SERVICE=techcopilot-prod-assistant
FAMILY=techcopilot-prod-assistant
CONTAINER=assistant
LOG_GROUP=/ecs/techcopilot-prod-assistant
MASTER_SECRET="arn:aws:secretsmanager:us-east-1:458799594709:secret:rds!cluster-354ddf05-2500-40c0-a536-ab171d0ac675-HGBVkG"
SQL_FILE="$(dirname "$0")/phase2.sql"
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
echo "Phase 2 applied. The previous image can no longer be rolled back without re-adding the two columns first."
