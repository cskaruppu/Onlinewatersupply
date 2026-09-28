# Online Water Supply (NeerNow)

A platform, launching first in Coimbatore, that connects households, apartments and sites with nearby water tanker owners, so water can be ordered and delivered quickly.

## What's built so far

**Phone OTP login**, working end to end:

| Part | Folder | Technology |
|---|---|---|
| API | `apps/api` | NestJS (Node.js 22, TypeScript), PostgreSQL 16, Redis 7 |
| Web app | `apps/web` | Next.js 15 (React 19): login and account pages |
| Containers | `apps/*/Dockerfile` | Red Hat UBI 9 Node.js 22, non-root, OpenShift-ready |
| OpenShift | `deploy/openshift` | Manifests + one-command deploy script |
| Local stack | `docker-compose.yml` | PostgreSQL, Redis, API, web |

### How login works

1. The user enters a mobile number. The API checks the rate limits: one code per 30 s, 3 per number per 10 min, 10 per network per hour.
2. A 6-digit code is created with a secure random generator. Only a keyed hash (HMAC-SHA256) is stored in Redis, and it expires after 5 minutes.
3. The code goes out by SMS (MSG91). In local and test environments it's written to the API log instead.
4. Checking the code is constant-time and the code works once. After 5 wrong codes, the number is locked for 15 minutes.
5. On success the user gets two HttpOnly, Secure, SameSite=Strict cookies:
   - a 15-minute access token (JWT)
   - a 30-day refresh token, rotated on every use, where reusing an old token ends the session everywhere
6. Phone numbers are stored encrypted (AES-256-GCM), found through a keyed hash, and always shown masked (`+91 98••• ••210`). IP addresses in the audit log are hashed.
7. The API is never exposed to the internet. The browser only talks to the web app, which forwards `/api/*` internally.
8. Other protections:
   - cross-site requests are blocked
   - security headers (CSP, HSTS, frame blocking)
   - input validation and a 10 KB request limit
   - a per-IP request limit
   - an audit trail of every sign-in event

### Pricing

Prices are fixed per address: capacity × distance band (A up to 5 km, B 5–10 km, C 10–15 km of road from the nearest filling point), plus any add-ons and the platform fee. There are no per-km charges. The zones, filling points, bands, rate card with caps, add-ons and saved-address tables are in `apps/api/migrations/002_pricing.sql`, and the rules are in `apps/api/src/pricing/`. See the pricing section of `docs/platform-features.md` for the reasoning.

## Run it locally

You need Docker (with Compose) and curl.

```bash
scripts/local-up.sh
```

This builds and starts everything, then runs the smoke test. Open **http://localhost:3000** and sign in with any Indian mobile number. Read the code from the API log (no real SMS is sent locally):

```bash
docker compose logs -f api | grep DEV-SMS
```

Stop it with `docker compose down` (add `-v` to wipe the local database).

## Test it

```bash
# API unit + end-to-end tests (needs PostgreSQL and Redis; the containers below are one way)
docker run -d --name t-pg -p 5432:5432 -e POSTGRESQL_USER=neernow -e POSTGRESQL_PASSWORD=test -e POSTGRESQL_DATABASE=neernow quay.io/sclorg/postgresql-16-c9s
docker run -d --name t-redis -p 6379:6379 -e REDIS_PASSWORD=test quay.io/sclorg/redis-7-c9s
cd apps/api && npm ci
TEST_DATABASE_URL=postgres://neernow:test@localhost:5432/neernow TEST_REDIS_URL=redis://:test@localhost:6379/1 npm test

# Smoke test against any running environment
scripts/smoke-test.sh http://localhost:3000 docker                 # local
scripts/smoke-test.sh https://<openshift-route> oc:neernow         # OpenShift, codes from pod logs
SMOKE_PHONE=98xxxxxxxx scripts/smoke-test.sh https://<url> prompt  # real SMS to your phone
```

GitHub Actions (`.github/workflows/ci.yml`) runs the API tests with real PostgreSQL and Redis, builds the web app, and checks the scripts and manifests on every push.

## Deploy to OpenShift

```bash
oc login --token=<token> --server=https://api.<your-cluster>:6443
deploy/openshift/deploy.sh neernow
```

See [`deploy/openshift/README.md`](deploy/openshift/README.md) for real SMS, custom domains, what gets created, and rollback.

## Configuration (API)

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL`, `REDIS_URL` | required | Connection strings |
| `JWT_SECRET`, `HASH_KEY` | required | At least 32 characters each, and different from each other |
| `DATA_ENCRYPTION_KEY` | required | 32 random bytes, base64 (`openssl rand -base64 32`) |
| `APP_ORIGINS` | `http://localhost:3000` | Comma-separated origins allowed to call the API |
| `COOKIE_SECURE` | `true` in production | Send cookies only over HTTPS |
| `SMS_PROVIDER` | `console` | `console` (log, testing only) or `msg91` |
| `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID`, `MSG91_OTP_VAR` | — / — / `otp` | MSG91 Flow API settings |
| `OTP_TTL_SECONDS`, `OTP_MAX_ATTEMPTS`, `OTP_LOCK_SECONDS` | 300 / 5 / 900 | Code lifetime, wrong-code limit, lock time |
| `OTP_RESEND_SECONDS`, `OTP_PER_PHONE_LIMIT`, `OTP_PER_IP_LIMIT` | 30 / 3 per 10 min / 10 per hour | Rate limits |
| `ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_TOKEN_TTL_DAYS` | 900 / 30 | Session lengths |
| `PLATFORM_FEE_PAISE` | 2900 | Platform fee per order (₹29) |

The web app needs only `API_INTERNAL_URL` (default `http://localhost:3001`).

## API endpoints

| Method and path | Purpose |
|---|---|
| `POST /api/v1/auth/otp/request` `{ phone }` | Send a code |
| `POST /api/v1/auth/otp/verify` `{ phone, otp }` | Sign in; sets session cookies |
| `POST /api/v1/auth/refresh` | Rotate the session |
| `POST /api/v1/auth/logout` | End the session |
| `GET /api/v1/me` | Signed-in user (masked phone, role) |
| `GET /api/v1/pricing/rate-card` | Public price list by capacity and distance band, add-ons, platform fee |
| `GET /healthz`, `GET /readyz` | Liveness and readiness (database + Redis) |

## Product design

- `prototype/index.html`: clickable prototype of the customer, tanker owner and admin portals (sample data)
- `docs/platform-features.md`: full feature, GPS and security plan
- `docs/technology-architecture.md`: technology stack, OTP and data protection design, costs
- `docs/coimbatore-launch.md`: Coimbatore launch plan
