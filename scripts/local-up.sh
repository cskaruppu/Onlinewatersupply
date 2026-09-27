#!/usr/bin/env bash
# Builds and starts the full NeerNow stack locally with Docker Compose, then runs the smoke test.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose up -d --build
echo "Waiting for the web app on http://localhost:3000 ..."
# Ready when the API answers through the web proxy (401 = up, just not signed in).
for _ in $(seq 1 90); do
  [[ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/api/v1/me)" == "401" ]] && break
  sleep 2
done
scripts/smoke-test.sh http://localhost:3000 docker
cat <<MSG

NeerNow is running at http://localhost:3000
Sign in with any Indian mobile number. The OTP is printed in the API log (no real SMS locally):
  docker compose logs -f api | grep DEV-SMS
Stop:    docker compose down        (add -v to delete the local database)
MSG
