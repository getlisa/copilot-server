#!/usr/bin/env bash
# Apply docs/sql/phase4.sql to production Aurora — the QuickBooks webhook event ledger.
#
# Run it from the repo root:
#     bash docs/sql/apply-phase4.sh
#
# Aurora is in a private VPC, so the statements have to execute from inside it: a one-off ECS task
# on the prod image is the only path. Modelled on apply-phase3.sh, with ONE difference that
# matters — phase 4 creates a NEW table, so it is owned by whoever runs it, and running it as the
# service's own `app_user` is exactly what we want. There is no credentialed revision to register
# and none to deregister. If you find yourself reaching for the RDS master secret here, something
# is wrong.
#
# ORDER: this DDL runs BEFORE the image that uses it, always. Prisma SELECTs every scalar column
# it knows about, so a webhook image deployed against a database without this table throws
# "relation does not exist" on every drain pass.
set -euo pipefail

export AWS_DEFAULT_REGION=us-east-1
CLUSTER=techcopilot-prod-ecs-cluster
SERVICE=techcopilot-prod-assistant
CONTAINER=assistant
LOG_GROUP=/ecs/techcopilot-prod-assistant
SQL_FILE="$(dirname "$0")/phase4.sql"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[ -f "$SQL_FILE" ] || { echo "missing $SQL_FILE" >&2; exit 1; }

# ---- 1. one self-contained runner, statements already split ------------------------------------
# The split happens HERE, not in the container: Prisma's $executeRawUnsafe takes one statement at
# a time, and a naive split on ";" would cut the DO $$ ... $$ block in half at its first inner
# semicolon. Doing it locally keeps a dollar-quote-aware splitter out of the payload, which
# matters because the ECS container-override limit is 8192 bytes.
python3 "$(dirname "$0")/build-runner.py" "$SQL_FILE" "$WORK/runsql.js"

# ---- 2. run it inside the VPC, on the service's own task definition -----------------------------
TASKDEF=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
            --query 'services[0].taskDefinition' --output text)
echo "using the running task definition: ${TASKDEF##*/}  (app_user credentials, no master secret)"

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
echo "Phase 4 applied. Deploy the webhook image next, then watch the drain."
