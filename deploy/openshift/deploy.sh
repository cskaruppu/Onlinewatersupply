#!/usr/bin/env bash
# Deploys NeerNow (PostgreSQL, Redis, API, web) to an OpenShift project and runs the smoke test.
#
# Usage:
#   oc login --token=<token> --server=https://api.<cluster>:6443
#   deploy/openshift/deploy.sh [project]            # default project: neernow
#
# Optional environment variables:
#   MSG91_AUTH_KEY, MSG91_TEMPLATE_ID  send real SMS through MSG91 (otherwise codes are written to the API log)
#   GOOGLE_MAPS_API_KEY                real road distances (Routes API); otherwise distances are estimated and
#                                      sample filling points are loaded (test environments only)
#   ROUTE_HOST                         custom hostname, e.g. app.neernow.in (DNS must point to the cluster router)
#   API_IMAGE, WEB_IMAGE               use images you built and pushed yourself instead of building in the cluster
#   SKIP_SMOKE_TEST=1                  do not run the smoke test at the end
#   INSECURE=1                         smoke test ignores TLS errors (clusters with self-signed router certificates)
set -euo pipefail

PROJECT="${1:-${PROJECT:-neernow}}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

say()  { printf '\n==> %s\n' "$*"; }
warn() { printf '    WARNING: %s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

command -v oc >/dev/null 2>&1 || die "The oc CLI is not installed. Download it from your OpenShift web console (? menu > Command line tools)."
command -v openssl >/dev/null 2>&1 || die "openssl is needed to generate secrets."
command -v tar >/dev/null 2>&1 || die "tar is needed to upload the source code."
oc whoami >/dev/null 2>&1 || die "You are not logged in. Run: oc login --token=<token> --server=<api-url>"

say "Project: $PROJECT (cluster: $(oc whoami --show-server), user: $(oc whoami))"
if ! oc get project "$PROJECT" >/dev/null 2>&1; then
  oc new-project "$PROJECT" --display-name="NeerNow" --description="Water tanker ordering platform" >/dev/null
  echo "    created project $PROJECT"
fi
oc project -q "$PROJECT" >/dev/null
OC=(oc -n "$PROJECT")

say "Secrets"
if "${OC[@]}" get secret neernow-secrets >/dev/null 2>&1; then
  echo "    neernow-secrets already exists; keeping it so existing data and sessions stay valid"
else
  "${OC[@]}" create secret generic neernow-secrets \
    --from-literal=POSTGRESQL_PASSWORD="$(openssl rand -hex 24)" \
    --from-literal=REDIS_PASSWORD="$(openssl rand -hex 24)" \
    --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
    --from-literal=HASH_KEY="$(openssl rand -hex 32)" \
    --from-literal=DATA_ENCRYPTION_KEY="$(openssl rand -base64 32)" >/dev/null
  "${OC[@]}" label secret neernow-secrets app.kubernetes.io/part-of=neernow >/dev/null
  echo "    generated neernow-secrets (database, Redis, token and encryption keys)"
  warn "Back up neernow-secrets (oc get secret neernow-secrets -o yaml). Losing DATA_ENCRYPTION_KEY makes stored phone numbers unreadable."
fi

if [[ -n "${MSG91_AUTH_KEY:-}" ]]; then
  [[ -n "${MSG91_TEMPLATE_ID:-}" ]] || die "Set MSG91_TEMPLATE_ID together with MSG91_AUTH_KEY."
  "${OC[@]}" create secret generic neernow-sms \
    --from-literal=MSG91_AUTH_KEY="$MSG91_AUTH_KEY" \
    --from-literal=MSG91_TEMPLATE_ID="$MSG91_TEMPLATE_ID" \
    --dry-run=client -o yaml | "${OC[@]}" apply -f - >/dev/null
  SMS_PROVIDER=msg91
elif "${OC[@]}" get secret neernow-sms >/dev/null 2>&1; then
  SMS_PROVIDER=msg91
else
  SMS_PROVIDER=console
  warn "No MSG91 credentials: OTP codes will be written to the API log instead of sent by SMS. Use this for testing only."
fi
echo "    SMS provider: $SMS_PROVIDER"

if [[ -n "${GOOGLE_MAPS_API_KEY:-}" ]]; then
  "${OC[@]}" create secret generic neernow-maps --from-literal=GOOGLE_MAPS_API_KEY="$GOOGLE_MAPS_API_KEY" \
    --dry-run=client -o yaml | "${OC[@]}" apply -f - >/dev/null
  DISTANCE_PROVIDER=google
elif "${OC[@]}" get secret neernow-maps >/dev/null 2>&1; then
  DISTANCE_PROVIDER=google
else
  DISTANCE_PROVIDER=estimate
  warn "No GOOGLE_MAPS_API_KEY: road distances are estimated and SAMPLE filling points are loaded. Use this for testing only."
fi
echo "    Distance provider: $DISTANCE_PROVIDER"

say "Public route"
"${OC[@]}" apply -f "$HERE/31-route.yaml" >/dev/null
if [[ -n "${ROUTE_HOST:-}" ]]; then
  "${OC[@]}" patch route neernow --type=merge -p "{\"spec\":{\"host\":\"$ROUTE_HOST\"}}" >/dev/null
fi
HOST="$("${OC[@]}" get route neernow -o jsonpath='{.spec.host}')"
[[ -n "$HOST" ]] || die "The route has no hostname yet. Check: oc -n $PROJECT describe route neernow"
URL="https://$HOST"
echo "    $URL"

say "Configuration"
"${OC[@]}" create configmap neernow-config \
  --from-literal=NODE_ENV=production \
  --from-literal=APP_ORIGINS="$URL" \
  --from-literal=COOKIE_SECURE=true \
  --from-literal=TRUST_PROXY=1 \
  --from-literal=SMS_PROVIDER="$SMS_PROVIDER" \
  --from-literal=ALLOW_CONSOLE_SMS="$([[ $SMS_PROVIDER == console ]] && echo true || echo false)" \
  --from-literal=DISTANCE_PROVIDER="$DISTANCE_PROVIDER" \
  --from-literal=ALLOW_ESTIMATED_DISTANCE="$([[ $DISTANCE_PROVIDER == estimate ]] && echo true || echo false)" \
  --from-literal=SEED_DEMO_DATA="$([[ $DISTANCE_PROVIDER == estimate ]] && echo true || echo false)" \
  --dry-run=client -o yaml | "${OC[@]}" apply -f - >/dev/null
"${OC[@]}" label configmap neernow-config app.kubernetes.io/part-of=neernow --overwrite >/dev/null
echo "    neernow-config updated"

say "Container images"
"${OC[@]}" apply -f "$HERE/00-builds.yaml" >/dev/null
if [[ -n "${API_IMAGE:-}" || -n "${WEB_IMAGE:-}" ]]; then
  [[ -n "${API_IMAGE:-}" && -n "${WEB_IMAGE:-}" ]] || die "Set both API_IMAGE and WEB_IMAGE, or neither."
  "${OC[@]}" import-image neernow-api:latest --from="$API_IMAGE" --confirm >/dev/null
  "${OC[@]}" import-image neernow-web:latest --from="$WEB_IMAGE" --confirm >/dev/null
  echo "    imported $API_IMAGE and $WEB_IMAGE"
else
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  for app in api web; do
    echo "    building neernow-$app in the cluster (this takes a few minutes the first time)..."
    tar -C "$ROOT/apps/$app" --exclude=./node_modules --exclude=./dist --exclude=./.next -czf "$TMP/$app.tar.gz" .
    "${OC[@]}" start-build "neernow-$app" --from-archive="$TMP/$app.tar.gz" --follow --wait \
      || die "Build of neernow-$app failed. See: oc -n $PROJECT logs bc/neernow-$app"
  done
fi

say "Database, cache, API, web, network policies and autoscaling"
"${OC[@]}" apply \
  -f "$HERE/10-postgres.yaml" \
  -f "$HERE/11-redis.yaml" \
  -f "$HERE/20-api.yaml" \
  -f "$HERE/30-web.yaml" \
  -f "$HERE/40-network-policy.yaml" \
  -f "$HERE/50-autoscaling.yaml"
# Pick up the latest configuration and images.
"${OC[@]}" rollout restart deployment/neernow-api deployment/neernow-web >/dev/null

say "Waiting for everything to become ready"
for d in neernow-postgres neernow-redis neernow-api neernow-web; do
  "${OC[@]}" rollout status "deployment/$d" --timeout=10m \
    || die "$d did not become ready. See: oc -n $PROJECT get pods; oc -n $PROJECT logs deployment/$d"
done

if [[ "${SKIP_SMOKE_TEST:-0}" != "1" ]]; then
  say "Smoke test"
  CURL_TLS=()
  [[ "${INSECURE:-0}" == "1" ]] && CURL_TLS=(-k)
  # Give the router a moment to pick up the new pods.
  for _ in $(seq 1 30); do
    code="$(curl -s -o /dev/null -w "%{http_code}" "${CURL_TLS[@]}" "$URL/healthz" || true)"
    [[ "$code" == "200" ]] && break
    sleep 2
  done
  if [[ "$SMS_PROVIDER" == "console" ]]; then
    "$ROOT/scripts/smoke-test.sh" "$URL" "oc:$PROJECT"
  else
    echo "    Real SMS is configured. To test with your own phone run:"
    echo "    SMOKE_PHONE=<your 10-digit number> scripts/smoke-test.sh $URL prompt"
  fi
fi

cat <<MSG

NeerNow is deployed.
  Open:         $URL
  Pods:         oc -n $PROJECT get pods
  API logs:     oc -n $PROJECT logs -f deployment/neernow-api
MSG
if [[ "$SMS_PROVIDER" == "console" ]]; then
  echo "  OTP codes:    oc -n $PROJECT logs -l app.kubernetes.io/name=neernow-api --tail=50 | grep DEV-SMS"
fi
