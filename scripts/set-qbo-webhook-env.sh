#!/usr/bin/env bash
# Put the two QuickBooks webhook verifier tokens into production.
#
# Run it from the repo root:
#     bash scripts/set-qbo-webhook-env.sh            # dry run — prints the plan, writes nothing
#     bash scripts/set-qbo-webhook-env.sh --apply    # does it
#
# Values are read from ./.env (gitignored) and are NEVER printed — the script reports key names,
# counts and a sha256 prefix, nothing else.
#
# WHY TWO TOKENS. The webhook endpoint POST /api/v1/webhooks/qbo is registered on BOTH Intuit
# keysets at the same URL, so the sandbox->production flip needs no portal change. Intuit issues a
# SEPARATE verifier token per keyset, so the receiver verifies the intuit-signature HMAC against
# both and logs which one matched — the only thing identifying the keyset an event came from.
#
# WHY THE THIRD STEP EXISTS, AND WHY IT IS NOT OPTIONAL. The deploy pipeline's ECS action derives
# each new revision from the task definition THE SERVICE IS CURRENTLY RUNNING, swapping only the
# image. So a revision registered and left unused is orphaned: the next deploy would base off the
# old one and the two new variables would silently vanish. They have to be on the running revision
# BEFORE the webhook image ships. T-15 hit exactly this and did register-then-update as two steps.
#
# It is a production redeploy, but a functionally inert one: same image, two extra environment
# variables that the currently deployed code does not read.
#
# This file lives in the repo ON PURPOSE. Its predecessor (set-qbo-env.sh, which merged the five
# QBO vars for T-15) was written to a per-session scratchpad and is gone, so the one documented
# way to do this had to be reconstructed from an AWS probe.
set -euo pipefail

export AWS_DEFAULT_REGION=us-east-1
SECRET_ID=techcopilot/prod/app
CLUSTER=techcopilot-prod-ecs-cluster
SERVICE=techcopilot-prod-assistant
FAMILY=techcopilot-prod-assistant
CONTAINER=assistant
KEYS=(QBO_WEBHOOK_VERIFIER_TOKEN_SANDBOX QBO_WEBHOOK_VERIFIER_TOKEN_PRODUCTION)

APPLY=false
[ "${1:-}" = "--apply" ] && APPLY=true
$APPLY || echo "=== DRY RUN — nothing will be written. Re-run with --apply. ==="

ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }
# umask BEFORE mktemp: the files themselves end up 0600, rather than relying on the directory
# mode alone to keep the production secret unreadable.
umask 077
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
chmod 700 "$WORK"

# ---- 1. read the two values out of .env, without echoing them ---------------------------------
for k in "${KEYS[@]}"; do
  v="$(grep -E "^${k}=" "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"'[:space:]')"
  [ -n "$v" ] || { echo "$k is empty or absent in .env" >&2; exit 1; }
  printf '%s' "$v" > "$WORK/$k"
  echo "  $k  present in .env  (sha256:$(printf '%s' "$v" | shasum -a 256 | cut -c1-12))"
done

# ---- 2. merge into the secret — never overwrite an existing key --------------------------------
aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --query SecretString --output text > "$WORK/secret.json"
SECRET_ARN="$(aws secretsmanager describe-secret --secret-id "$SECRET_ID" --query ARN --output text)"

python3 - "$WORK" "${KEYS[@]}" <<'PY'
import json, pathlib, sys
work = pathlib.Path(sys.argv[1]); keys = sys.argv[2:]
d = json.loads((work / "secret.json").read_text())
before = len(d)
for k in keys:
    if k in d:
        print(f"  {k}: already in the secret — left untouched")
    else:
        d[k] = (work / k).read_text()
        print(f"  {k}: will be ADDED")
(work / "secret.new.json").write_text(json.dumps(d))
print(f"  secret keys: {before} -> {len(d)}")
PY

if $APPLY; then
  aws secretsmanager put-secret-value --secret-id "$SECRET_ID" \
    --secret-string "file://$WORK/secret.new.json" --query VersionId --output text \
    | sed 's/^/  new secret version: /'
else
  echo "  (dry run: put-secret-value skipped)"
fi

# Shred the cleartext copies NOW rather than at exit. Everything below waits on an ECS rollout,
# so the EXIT trap alone would leave the whole production secret on disk for minutes.
rm -f "$WORK/secret.json" "$WORK/secret.new.json" "$WORK"/QBO_WEBHOOK_VERIFIER_TOKEN_*

# ---- 3. register a task-definition revision carrying both references ---------------------------
CURRENT="$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
            --query 'services[0].taskDefinition' --output text)"
echo "  service currently runs: ${CURRENT##*/}"
aws ecs describe-task-definition --task-definition "$CURRENT" --query taskDefinition > "$WORK/td.json"

python3 - "$WORK" "$SECRET_ARN" "$CONTAINER" "${KEYS[@]}" <<'PY'
import json, pathlib, sys
work = pathlib.Path(sys.argv[1]); arn, container, keys = sys.argv[2], sys.argv[3], sys.argv[4:]
td = json.loads((work / "td.json").read_text())
for f in ("taskDefinitionArn","revision","status","requiresAttributes","compatibilities",
          "registeredAt","registeredBy","deregisteredAt"):
    td.pop(f, None)
c = next(c for c in td["containerDefinitions"] if c["name"] == container)
have = {s["name"] for s in c.setdefault("secrets", [])}
added = [k for k in keys if k not in have]
for k in added:
    c["secrets"].append({"name": k, "valueFrom": f"{arn}:{k}::"})
(work / "td.new.json").write_text(json.dumps(td))
print(f"  container secrets: {len(have)} -> {len(c['secrets'])}"
      + (f"  (adding {', '.join(added)})" if added else "  (already present — no change)"))
(work / "changed").write_text("yes" if added else "no")
PY

if [ "$(cat "$WORK/changed")" = "no" ]; then
  echo "=== Both keys are already on the running revision. Nothing to do. ==="; exit 0
fi

if ! $APPLY; then
  echo "  (dry run: register-task-definition and update-service skipped)"
  echo "=== DRY RUN complete. Re-run with --apply to write. ==="
  exit 0
fi

NEW="$(aws ecs register-task-definition --cli-input-json "file://$WORK/td.new.json" \
        --query 'taskDefinition.taskDefinitionArn' --output text)"
echo "  registered: ${NEW##*/}"

# ---- 4. move the service onto it ---------------------------------------------------------------
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" \
  --task-definition "$NEW" --force-new-deployment --query 'service.taskDefinition' --output text \
  | sed 's/^/  service now targets: /'
echo "  waiting for the deployment to stabilise (a few minutes)..."
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].{taskDef:taskDefinition,running:runningCount,desired:desiredCount,deployments:length(deployments)}' \
  --output json
echo "=== Done. Verify /health, then ship Phase 1. ==="
