#!/usr/bin/env bash
# Deploy worker.js to Cloudflare via the REST API (no Node/wrangler needed).
# Needs ~/.config/cloudflare.env (CLOUDFLARE_API_TOKEN). Creates the KV namespace and the
# write key on first run; re-running redeploys the code and keeps both.
set -euo pipefail

ACCOUNT=d92d5234f1a14413748b72185837305d
NAME=bitcoin-node
SUBDOMAIN=alejandro-d92
HERE="$(cd "$(dirname "$0")" && pwd)"
APP_ENV="$HOME/.config/btc-dashboard.env"
API="https://api.cloudflare.com/client/v4/accounts/$ACCOUNT"

set -a; . "$HOME/.config/cloudflare.env"; set +a
cf() { curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$@"; }
ok() { python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get("success") else (print(d.get("errors"),file=sys.stderr) or 1))'; }

# KV namespace: reuse if it exists
KV_ID=$(cf "$API/storage/kv/namespaces?per_page=100" | python3 -c '
import sys,json
d=json.load(sys.stdin)
print(next((n["id"] for n in d.get("result",[]) if n["title"]=="btc-node-dashboard"),""))')
if [ -z "$KV_ID" ]; then
  KV_ID=$(cf -X POST -H 'Content-Type: application/json' -d '{"title":"btc-node-dashboard"}' "$API/storage/kv/namespaces" \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["result"]["id"])')
  echo "created KV namespace"
fi

# Write key: generate once, keep in a private file
if [ ! -f "$APP_ENV" ]; then
  umask 077
  printf 'PUSH_URL=https://%s.%s.workers.dev/api/push\nWRITE_KEY=%s\n' "$NAME" "$SUBDOMAIN" "$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')" > "$APP_ENV"
  echo "created write key"
fi
WRITE_KEY=$(grep '^WRITE_KEY=' "$APP_ENV" | cut -d= -f2-)

META=$(KV_ID="$KV_ID" WRITE_KEY="$WRITE_KEY" python3 -c '
import json,os
print(json.dumps({"main_module":"worker.js","compatibility_date":"2025-01-01",
 "bindings":[{"type":"kv_namespace","name":"KV","namespace_id":os.environ["KV_ID"]},
             {"type":"secret_text","name":"WRITE_KEY","text":os.environ["WRITE_KEY"]}]}))')

cf -X PUT "$API/workers/scripts/$NAME" \
  -F "metadata=$META;type=application/json" \
  -F "worker.js=@$HERE/worker.js;type=application/javascript+module;filename=worker.js" | ok
echo "uploaded worker"

cf -X POST -H 'Content-Type: application/json' -d '{"enabled":true,"previews_enabled":false}' \
  "$API/workers/scripts/$NAME/subdomain" | ok
echo "enabled workers.dev route"
echo "URL: https://$NAME.$SUBDOMAIN.workers.dev/"
