# Bank Statement Extraction Service

Production-oriented service that extracts **canonical bank transactions** from statement documents (PDF, scanned PDF/OCR, images, CSV, XLS/XLSX), validates them, detects suspected duplicates, reconciles balances, scores confidence, persists results, and returns a sanitized JSON API response.

## Architecture

```
Upload / URL
 → Security validation (magic bytes / SSRF)
 → Document extraction (PDF / OCR / spreadsheet)
 → Transaction reconstruction + normalization
 → Duplicate detection (flag only)
 → Validation + reconciliation + confidence
 → JSON Schema validation
 → Atomic persistence
 → Public API response
```

Key modules live under `src/modules/` (`ingestion`, `security`, `extraction`, `transactions`, `normalization`, `duplicates`, `validation`, `reconciliation`, `confidence`, `database`, `api`, `runtime`).

The extraction engine is **deterministic** (no LLMs). Missing financial fields stay `null` — values are never fabricated.

## Supported formats

PDF, JPG, JPEG, PNG, CSV, XLS, XLSX.

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Liveness |
| GET | `/ready` | Readiness (DB when configured) |
| POST | `/api/v1/statements/extract` | Sync extract (multipart `file` **or** JSON URL) |
| POST | `/api/v1/statements` | Async enqueue (202) |
| GET | `/api/v1/statements/:id/status` | Async status (`X-Access-Token` required) |
| GET | `/api/v1/statements/:id/result` | Async result (`X-Access-Token` required) |
| GET | `/api/docs/openapi.json` | OpenAPI 3 |
| GET | `/api/metrics` | In-process counters (no PII labels) |

### Authentication

- Set `API_KEYS` (comma-separated). **Required when `NODE_ENV=production`.**
- Send `Authorization: Bearer <key>` or `X-API-Key: <key>`.
- Statement reads also require the opaque `access_token` returned at creation (or the owning API key hash). This prevents IDOR via id guessing.

### Example: multipart upload

```bash
curl -s -X POST http://localhost:3000/api/v1/statements/extract \
  -H "X-API-Key: $API_KEY" \
  -F file=@statement.csv
```

### Example: URL extract

```bash
curl -s -X POST http://localhost:3000/api/v1/statements/extract \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{"source_type":"url","url":"https://example.com/statement.pdf"}'
```

## Security highlights

- SSRF: HTTP(S) only; DNS resolution validated for all addresses; redirect re-validation; private/metadata blocked
- Uploads: magic-byte sniffing; safe internal filenames; size limits; not served publicly
- Account numbers masked in API/DB (`****1234`)
- Structured logging with redaction (no API keys / tokens / passwords)
- Rate limits + bounded concurrent document processing
- CORS allowlist via `CORS_ORIGINS` (disabled-by-default in production when empty)

## Configuration

See `.env.example` for all knobs (`MAX_UPLOAD_BYTES`, `MAX_PDF_PAGES`, `MAX_CONCURRENT_DOCUMENTS`, `MAX_PROCESSING_TIME_MS`, rate limits, etc.).

## Separate frontend + API hosts (no Docker)

Run the API on one server and the static UI on another.

**API host**

```bash
npm ci
npx prisma migrate deploy
npm run build
# .env: NODE_ENV=production, DATABASE_URL, API_KEYS, WEB_USERS,
#       SERVE_WEB=false, CORS_ORIGINS=https://your-frontend.example
npm start
```

**Frontend host**

```bash
BS_API_BASE=https://your-api.example npm run build:frontend
# Upload frontend-dist/ to nginx, cPanel, S3, etc.
```

Cookies use `SameSite=None; Secure` when `CORS_ORIGINS` is set (HTTPS required on both hosts). Edit `frontend-dist/config.js` or rebuild with a new `BS_API_BASE` to point at a different API.

## Database

MySQL / MariaDB via Prisma (WAMP-friendly). Money columns use `DECIMAL(18,4)`.

```bash
# Create DB then:
npx prisma generate
npx prisma migrate deploy
```

Set `DATABASE_URL=mysql://root@localhost:3306/bs_app` in `.env`.

Persistence is atomic: `statements` + `transactions` + `analyses` (keyed by `reference_id`) + extraction/validation runs. Search/render uses MySQL (`GET /api/v1/analyses/search`, `GET /api/v1/analyses/:referenceId`). Without `DATABASE_URL`, the app falls back to `uploads/catalog/`.

## Testing

```bash
npm test
npm run test:coverage
npm run lint
npm run typecheck
npm run build
```

## Deployment

Docker is optional. Prefer the [separate frontend + API hosts](#separate-frontend--api-hosts-no-docker) flow when you deploy without containers.

### Local Docker

```bash
docker compose up --build
```

Compose now uses **MySQL 8** (matches Prisma). See `docs/RUNBOOK.md` for operations.

### Railway

1. Create a new Railway project from this repo (Dockerfile builder — see `railway.toml`).
2. Add a **MySQL** plugin/service and link it to the app.
3. Set variables on the app service:

| Variable | Example | Notes |
|----------|---------|--------|
| `NODE_ENV` | `production` | Required |
| `API_KEYS` | long random string | Required in production |
| `DATABASE_URL` | `mysql://…` | Or rely on Railway `MYSQL*` vars (auto-resolved) |
| `WEB_USERS` | `[{"email":"you@co.com","password":"…","name":"You"}]` | Seeds UI login |
| `DATA_DIR` | `/data` | Optional volume mount for durable UI users |
| `UPLOAD_DIR` | `/tmp/uploads` | Ephemeral OK — results live in MySQL |
| `MAX_CONCURRENT_DOCUMENTS` | `2` | Keep low on small plans |
| `MAX_PROCESSING_TIME_MS` | `180000` | Raise for large PDFs |

4. Deploy. Startup runs `prisma migrate deploy` then `node dist/index.js`.
5. Open the public URL → sign in with a `WEB_USERS` account (or the demo user if unset).

**Notes:** keep **1 replica** (web sessions are in-memory). Attach a volume at `DATA_DIR` if you add UI users and need them to survive redeploys.

## Adding a bank parser

There are currently **no bank-specific profiles** — only generic format parsers. To add a profile:

1. Add a detector under `src/modules/parsers/`
2. Wire it in the extraction orchestrator without changing the canonical transaction contract
3. Add synthetic fixtures + Group 7-style regression tests

## Troubleshooting

| Symptom | Check |
|---------|--------|
| 401 | `API_KEYS` / header |
| 403 on status/result | Missing/wrong `X-Access-Token` |
| 413 | File/page/pixel limits |
| 429 | Rate limit or concurrency |
| 502/504 | URL fetch / processing timeout |
| SSRF block | Private/metadata host |
