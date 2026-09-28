#!/usr/bin/env bash
# End-to-end check of OTP login against a running NeerNow environment.
#
# Usage:
#   scripts/smoke-test.sh <base-url> [otp-source]
#
#   otp-source  where to read the one-time code from:
#     docker        docker compose logs (local stack, SMS_PROVIDER=console)   [default for localhost]
#     oc:<project>  OpenShift API pod logs (SMS_PROVIDER=console)             [default otherwise: oc:neernow]
#     prompt        type the code from a real SMS (SMS_PROVIDER=msg91; set SMOKE_PHONE to your number)
#
# Environment: SMOKE_PHONE (10-digit mobile, default: a random test number), INSECURE=1 (skip TLS checks).
set -euo pipefail

BASE="${1:?Usage: $0 <base-url> [docker|oc:<project>|prompt]}"
BASE="${BASE%/}"
SRC="${2:-}"
if [[ -z "$SRC" ]]; then
  [[ "$BASE" == *localhost* || "$BASE" == *127.0.0.1* ]] && SRC=docker || SRC=oc:neernow
fi
PHONE="${SMOKE_PHONE:-9$(date +%s | cut -c2-10)}"
JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT
CURL=(curl -sS --max-time 20 -c "$JAR" -b "$JAR")
[[ "${INSECURE:-0}" == "1" ]] && CURL+=(-k)
PASS=0; FAIL=0
EXTRA_HEADERS=()
json_str() { grep -o "\"$1\":\"[^\"]*\"" <<<"$BODY" | head -1 | cut -d'"' -f4 || true; }

ok()   { echo "  PASS  $1"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
# status <method> <path> [json-body] [origin]  -> prints HTTP status, body saved in $BODY
status() {
  local method="$1" path="$2" data="${3:-}" origin="${4:-$BASE}" args=("${EXTRA_HEADERS[@]}")
  [[ -n "$data" ]] && args+=(-H 'Content-Type: application/json' --data "$data")
  BODY="$("${CURL[@]}" -X "$method" -H "Origin: $origin" "${args[@]}" -w '\n%{http_code}' "$BASE$path")"
  CODE="${BODY##*$'\n'}"; BODY="${BODY%$'\n'*}"
}
expect() { # expect <code> <label>
  if [[ "$CODE" == "$1" ]]; then ok "$2 ($CODE)"; else bad "$2: expected $1, got $CODE ${BODY:0:200}"; fi
}

read_otp() {
  local last3="${PHONE: -3}" line=""
  case "$SRC" in
    docker)
      line="$(docker compose logs api --since 2m 2>/dev/null | grep 'DEV-SMS' | grep "••${last3} is" | tail -1 || true)";;
    oc:*)
      line="$(oc logs -n "${SRC#oc:}" -l app.kubernetes.io/name=neernow-api --since=2m --tail=-1 --max-log-requests=10 2>/dev/null \
              | grep 'DEV-SMS' | grep "••${last3} is" | tail -1 || true)";;
    prompt)
      read -r -p "  Enter the 6-digit code sent to +91 $PHONE: " line;;
  esac
  grep -oE '(is |^)[0-9]{6}' <<<"$line" | grep -oE '[0-9]{6}' | tail -1 || true
}

echo "NeerNow smoke test: $BASE  (phone +91 ${PHONE:0:2}••• ••${PHONE: -3}, codes from: $SRC)"

status GET /healthz;                          expect 200 "web is up"
status GET /api/v1/me;                        expect 401 "signed-out user is refused"
HEADERS="$("${CURL[@]}" -o /dev/null -D - "$BASE/login")"
grep -qi '^content-security-policy:' <<<"$HEADERS" && ok "login page sends a Content-Security-Policy" || bad "no Content-Security-Policy header"
grep -qi '^x-frame-options: DENY' <<<"$HEADERS" && ok "login page cannot be framed" || bad "missing X-Frame-Options"

status POST /api/v1/auth/otp/request '{"phone":"12345"}';            expect 400 "invalid phone number rejected"
status POST /api/v1/auth/otp/request "{\"phone\":\"$PHONE\"}" https://evil.example; expect 403 "cross-site request blocked"
status POST /api/v1/auth/otp/request "{\"phone\":\"$PHONE\"}";       expect 200 "OTP requested"
status POST /api/v1/auth/otp/request "{\"phone\":\"$PHONE\"}";       expect 429 "immediate resend is rate-limited"

sleep 1
OTP="$(read_otp)"
if [[ -z "$OTP" ]]; then
  bad "could not read the OTP (source: $SRC)"
else
  ok "OTP delivered"
  WRONG=$([[ "$OTP" == "000000" ]] && echo 111111 || echo 000000)
  status POST /api/v1/auth/otp/verify "{\"phone\":\"$PHONE\",\"otp\":\"$WRONG\"}"; expect 400 "wrong code rejected"
  grep -q '"attemptsLeft":4' <<<"$BODY" && ok "wrong attempts are counted" || bad "attempt counter missing: $BODY"
  status POST /api/v1/auth/otp/verify "{\"phone\":\"$PHONE\",\"otp\":\"$OTP\"}";   expect 200 "correct code signs in"
  grep -q 'nn_at' "$JAR" && ok "session cookie set" || bad "no session cookie"
  status POST /api/v1/auth/otp/verify "{\"phone\":\"$PHONE\",\"otp\":\"$OTP\"}";   expect 400 "code cannot be reused"
  status GET /api/v1/me;                          expect 200 "signed-in profile loads"
  grep -q '"phoneMasked":"+91 ' <<<"$BODY" && ! grep -q "$PHONE" <<<"$BODY" && ok "phone number is masked" || bad "phone not masked: $BODY"

  # Booking: address -> band -> quote -> order (double tap) -> cancel.
  status GET /api/v1/localities;                  expect 200 "localities load"
  LOC_ID="$(grep -o '"id":[0-9]*,"name":"Saravanampatti"' <<<"$BODY" | grep -o '[0-9]*' | head -1 || true)"
  status POST /api/v1/addresses "{\"label\":\"Home\",\"line1\":\"1, Smoke Test Street\",\"localityId\":${LOC_ID:-0},\"pincode\":\"641035\"}"
  expect 201 "address saved"
  ADDRESS_ID="$(json_str id)"
  grep -q '"band":"A"' <<<"$BODY" && ok "address priced in band A" || bad "unexpected band: ${BODY:0:200}"
  QUOTE_BODY="{\"addressId\":\"$ADDRESS_ID\",\"capacityKl\":12,\"slot\":\"asap\"}"
  ORDER_BODY="${QUOTE_BODY%\}},\"paymentMethod\":\"cash\"}"
  status POST /api/v1/orders/quote "$QUOTE_BODY";  expect 200 "price quoted"
  QUOTED="$(grep -o '"totalPaise":[0-9]*' <<<"$BODY" | head -1 || true)"
  KEY="smoke-$(date +%s)-$RANDOM"
  EXTRA_HEADERS=(-H "Idempotency-Key: $KEY")
  status POST /api/v1/orders "$ORDER_BODY";        expect 201 "tanker booked"
  ORDER_ID="$(json_str id)"
  grep -q "$QUOTED" <<<"$BODY" && ok "booked at the quoted price" || bad "price differs from quote: ${BODY:0:200}"
  status POST /api/v1/orders "$ORDER_BODY";        expect 201 "double tap returns the same order"
  [[ "$(json_str id)" == "$ORDER_ID" ]] && ok "no duplicate order" || bad "duplicate order created"
  EXTRA_HEADERS=()
  status POST "/api/v1/orders/$ORDER_ID/cancel" '{}'; expect 200 "order cancelled"
  status DELETE "/api/v1/addresses/$ADDRESS_ID" '{}'; expect 204 "address removed"

  status POST /api/v1/auth/refresh '{}';          expect 200 "session refresh rotates tokens"
  status POST /api/v1/auth/logout '{}';           expect 204 "sign out"
  status GET /api/v1/me;                          expect 401 "signed out session is refused"
fi

echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
