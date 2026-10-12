# Production Runbook — Bank Statement Extraction Service

## Start

```bash
cp .env.example .env   # set DATABASE_URL, API_KEYS for production
npm ci
npx prisma generate
npx prisma migrate deploy
npm run build
npm start
```

Docker:

```bash
docker compose up --build -d
```

## Stop / restart

```bash
# process
kill -TERM <pid>          # graceful (15s force)
docker compose restart api
docker compose down
```

## Migrations

```bash
npx prisma migrate deploy   # production
npx prisma migrate dev      # development only
npx prisma validate
```

Fresh DB: start MySQL, set `DATABASE_URL`, run `migrate deploy`.

## Health

- Liveness: `GET /health` → 200
- Readiness: `GET /ready` → 200 (503 if DB configured but down)
- API health: `GET /api/health`

## Logs

Structured JSON via pino. Redacts authorization, API keys, passwords, access tokens.

Useful fields: `request_id` (pino-http), `document_id`, processing duration, `error.code`, `reconciliation_status`, `transaction_count`.

Never expect full account numbers or OCR text in logs.

## Failed extraction

1. Note `error.code` from API response
2. Check metrics: `GET /api/metrics`
3. Confirm file type via magic bytes (not extension)
4. For URL path: confirm SSRF policy / allowlist / timeouts
5. For OCR: check image resolution and `MAX_IMAGE_PIXELS` / `OCR_TIMEOUT_MS`

## Temporary files

Stored under `UPLOAD_DIR` as `stmt_<id>.<ext>` (not publicly served). Deleted after pipeline unless `RETAIN_TEMP_FILES=true`. Orphans cleaned on startup/shutdown and by retention (`DOCUMENT_RETENTION_HOURS`).

Manual cleanup:

```bash
find ./uploads -name 'stmt_*' -mtime +1 -delete
```

## Backups

- Use managed MySQL backups or `mysqldump` nightly
- Retain per policy (recommend ≥ 30 days for financial audit trails)
- Restore: stop writers → restore dump → `prisma migrate deploy` → verify `/ready`
- Do not drop historical extraction records without an explicit retention decision

## Railway

1. Builder: Dockerfile (`railway.toml`)
2. Healthcheck: `GET /health`
3. Startup: `node scripts/railway-start.mjs` (migrate + serve)
4. Required: `API_KEYS`, MySQL (`DATABASE_URL` or plugin `MYSQL*` vars)
5. Recommended: `WEB_USERS`, volume on `DATA_DIR` for durable UI accounts
6. Single replica only (in-memory sessions)
7. Trust proxy is on in production so `Secure` cookies work behind Railway TLS

## Secrets rotation

1. Add new key to `API_KEYS`
2. Deploy
3. Cut clients over
4. Remove old key
5. Rotate DB password / compose secrets independently

## Rollback

1. Redeploy previous image/tag
2. DB migrations are forward-only — avoid destructive migrations
3. Keep prior image artifacts for instant rollback

## Dependency updates

```bash
npm audit
npm update <safe-package>
npm test && npm run typecheck && npm run build
```

Do not blindly major-upgrade `xlsx`, Prisma, or native OCR/canvas stacks without regression tests.

## Capacity notes

- `MAX_CONCURRENT_DOCUMENTS` bounds simultaneous pipelines
- `RATE_LIMIT_EXTRACT_MAX` protects extract endpoints
- Prefer horizontal scale behind a reverse proxy with HTTPS termination
