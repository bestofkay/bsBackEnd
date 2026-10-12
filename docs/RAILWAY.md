# Deploy to Railway

## 1. Create services

1. New Railway project → **Deploy from GitHub** (this repo).
2. Railway detects `railway.toml` / `Dockerfile`.
3. Add a **MySQL** database and link it to the web service.

## 2. Environment variables

Set on the **app** service:

```bash
NODE_ENV=production
API_KEYS=<long-random-secret>
WEB_USERS=[{"email":"you@company.com","password":"choose-a-strong-password","name":"You"}]
UPLOAD_DIR=/tmp/uploads
MAX_CONCURRENT_DOCUMENTS=2
MAX_PROCESSING_TIME_MS=180000
LOG_LEVEL=info
```

`DATABASE_URL` is optional if the MySQL plugin exposes `MYSQLHOST` / `MYSQLUSER` / `MYSQLPASSWORD` / `MYSQLDATABASE` — the app builds `mysql://…` automatically.

Optional durability for UI users across redeploys:

1. Create a volume mounted at `/data`
2. Set `DATA_DIR=/data`

## 3. Deploy settings

- Healthcheck path: `/health` (already in `railway.toml`)
- Replicas: **1** (sessions are in-memory)
- Start command: image default (`node scripts/railway-start.mjs`)

## 4. Verify

```bash
curl -s https://<your-app>.up.railway.app/health
curl -s https://<your-app>.up.railway.app/ready
```

Open the URL in a browser → sign in with `WEB_USERS` credentials → run an analysis.

## 5. Tuning tips

| Symptom | Knob |
|---------|------|
| Slow / timeout on big PDFs | Raise `MAX_PROCESSING_TIME_MS`, keep `MAX_CONCURRENT_DOCUMENTS=1–2` |
| OOM on OCR | Lower `MAX_IMAGE_PIXELS`, use larger Railway plan |
| Persist timeout on fat ledgers | Already 120s in Prisma transactions |
| Login lost after redeploy | Mount volume + `DATA_DIR` |
| 401 on API clients | Send `X-API-Key: $API_KEYS` |

## 6. Local parity

```bash
docker compose up --build
```

Uses MySQL 8 + the same Dockerfile entrypoint.
