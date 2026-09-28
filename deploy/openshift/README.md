# Deploying NeerNow to OpenShift

One script sets up everything in an OpenShift project: PostgreSQL, Redis, the API, the web app, an HTTPS route, network policies and autoscaling. It then runs the login smoke test against the live URL.

## What you need

- An OpenShift 4.x cluster and a user who can create a project (or an existing project you can deploy into).
- The `oc` CLI (download it from the web console: **?** menu → **Command line tools**), plus `openssl`, `tar`, `curl` and `bash`.
- The cluster must be able to pull from `registry.access.redhat.com` (base images) and `quay.io` (PostgreSQL and Redis images). Most clusters can.
- Docker-strategy builds must be allowed. This is the default; some locked-down clusters disable it. See [Building images yourself](#building-images-yourself) if yours does.

## Deploy

```bash
# 1. Log in. Copy this command from the web console: your name (top right) -> "Copy login command".
oc login --token=sha256~xxxx --server=https://api.<your-cluster>:6443

# 2. Deploy into the project "neernow" (created if it doesn't exist).
deploy/openshift/deploy.sh neernow
```

The first run takes about 5–10 minutes, mostly for the two image builds. At the end you'll see the smoke-test results and the public URL, for example `https://neernow-neernow.apps.<your-cluster>`.

Run the same command again to deploy new code. Secrets are kept, the images are rebuilt, and the pods roll over with no downtime.

### Real SMS with MSG91

Without MSG91 credentials, the API writes each OTP to its log so you can test. Read the codes with:

```bash
oc -n neernow logs -l app.kubernetes.io/name=neernow-api --tail=50 | grep DEV-SMS
```

To send real SMS, first create a DLT-approved OTP template in MSG91 with a variable named `otp`. Then deploy with your credentials:

```bash
MSG91_AUTH_KEY=xxxx MSG91_TEMPLATE_ID=yyyy deploy/openshift/deploy.sh neernow
SMOKE_PHONE=98xxxxxxxx scripts/smoke-test.sh https://<your-route-host> prompt   # type the code you receive
```

Log-based OTP (`SMS_PROVIDER=console`) is only for testing. The API refuses to start with it in production unless `ALLOW_CONSOLE_SMS=true`, which the script sets only when no MSG91 credentials exist.

### Real road distances with Google Maps

Without a key, test deployments estimate road distance and load **sample** filling points. For real distances, create a Google Cloud API key with the **Routes API** enabled. Restrict the key to that API, and to your cluster's egress IPs if you can. Then:

```bash
GOOGLE_MAPS_API_KEY=xxxx deploy/openshift/deploy.sh neernow
```

With a key, sample filling points are not loaded. Add your licensed filling points before customers save addresses:

```bash
oc -n neernow exec -i deployment/neernow-postgres -- psql -U neernow -d neernow <<'SQL'
INSERT INTO filling_points (zone_id, name, source, lat, lng, licence_no)
SELECT id, 'Kongu RO plant, Saravanampatti', 'treated', 11.0801, 77.0012, 'TN/CBE/1234' FROM zones WHERE code = 'north-east';
SQL
```

### Your own domain

```bash
ROUTE_HOST=app.neernow.in deploy/openshift/deploy.sh neernow
```

Point a DNS CNAME for `app.neernow.in` at your cluster's router hostname. For a trusted certificate on a custom domain, add it to the route or use cert-manager.

## What gets created

| Resource | Details |
|---|---|
| `neernow-secrets` | Generated once: database and Redis passwords, JWT key, hashing key, AES-256 encryption key. **Back it up.** Without `DATA_ENCRYPTION_KEY`, stored phone numbers can't be read. |
| `neernow-sms` | Optional MSG91 credentials |
| `neernow-maps` | Optional Google Maps API key |
| `neernow-config` | Allowed origin (the route URL), secure cookies, SMS provider |
| `neernow-postgres` | PostgreSQL 16, 5 Gi persistent volume, 1 pod |
| `neernow-redis` | Redis 7 for OTP hashes and rate limits (short-lived data, no volume) |
| `neernow-api` | 2+ pods, **internal only**, read-only filesystem, health probes, auto-rollout on new image |
| `neernow-web` | 2+ pods, the only component reachable from the internet |
| Route `neernow` | HTTPS (edge TLS), HTTP redirected to HTTPS, HSTS |
| Network policies | Deny by default; allow router → web → API → PostgreSQL/Redis only |
| Autoscalers | API 2–6 pods, web 2–4 pods at 70% CPU; disruption budgets keep 1 pod up during node maintenance |

Every pod runs under OpenShift's default `restricted-v2` security policy: a random non-root user, no Linux capabilities, and no privilege escalation.

## Useful commands

```bash
oc -n neernow get pods                                   # status
oc -n neernow logs -f deployment/neernow-api             # API logs
oc -n neernow rollout undo deployment/neernow-api        # roll back the API to the previous version
oc -n neernow get secret neernow-secrets -o yaml > neernow-secrets.backup.yaml   # back up secrets (store safely!)
deploy/openshift/undeploy.sh neernow                     # remove workloads, keep data and secrets
deploy/openshift/undeploy.sh neernow --all               # remove everything including the database
```

## Building images yourself

If your cluster doesn't allow Docker builds, build and push the images from your machine or CI, then deploy with them:

```bash
podman build -t quay.io/<you>/neernow-api:1.0 apps/api && podman push quay.io/<you>/neernow-api:1.0
podman build -t quay.io/<you>/neernow-web:1.0 apps/web && podman push quay.io/<you>/neernow-web:1.0
API_IMAGE=quay.io/<you>/neernow-api:1.0 WEB_IMAGE=quay.io/<you>/neernow-web:1.0 deploy/openshift/deploy.sh neernow
```

For a private registry, link a pull secret first: `oc -n neernow create secret docker-registry ...` followed by `oc -n neernow secrets link default <secret> --for=pull`.

## Before real customers use it

- Configure MSG91 (real SMS) and remove the log-based OTP.
- Move PostgreSQL to a managed service or the Crunchy Postgres operator, with automated backups and a standby replica.
- Store `neernow-secrets` in a secrets manager (for example Vault or the External Secrets Operator), not only in the cluster.
- Use your own domain with a trusted certificate.
- Book a penetration test (VAPT) with a CERT-In empanelled auditor.
