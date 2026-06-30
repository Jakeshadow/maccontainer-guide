# Chapter 4: Stack Templates
**Status: Paid Content**

---

Five production-ready stack templates. Each includes the original docker-compose.yml, the converted Apple Container start script, and the nginx/DNS configuration. Swap in your project and go.

## Template 1: Nginx + Node.js API

The most common web stack — reverse proxy in front of an Express/Fastify/Koa API.

**Docker Compose (original)** — see Chapter 3 for the full YAML.

**Conversion Highlights:**
- Nginx `proxy_pass http://node-app.dev.internal:3000` replaces `proxy_pass http://app:3000`
- No port mapping — Nginx listens on 80, Node on 3000, no collision
- Health-check wrapper in start script polls `/health` endpoint

**Start script:** `start-node-stack.sh` (included in conversion-scripts.zip)

## Template 2: Python + PostgreSQL

Django/FastAPI/Flask with a PostgreSQL database.

**Conversion Highlights:**
- Connection string changes from `db:5432` to `postgres-db.dev.internal:5432`
- Named volume for Postgres data (`pgdata`) — survives container restarts
- `pip install -r requirements.txt` runs inside the container on first start

**Start script:** `start-python-stack.sh`

## Template 3: Rails + Redis (Premium)

Rails API with Sidekiq + Redis for background jobs.

**Architecture:**
```
nginx (80) → Rails API (3000) → PostgreSQL (5432)
                              → Redis (6379) ← Sidekiq worker
```

**Conversion Highlights:**
- Sidekiq and Rails web share the same image — run with different commands
- Redis accessible at `redis.dev.internal:6379`
- Action Cable (WebSocket) works through Nginx with proper `Upgrade` headers

**Start script:** `start-rails-stack.sh`

## Template 4: Go + PostgreSQL (Premium)

Go binary with PostgreSQL — minimal, fast, single-binary deployment.

**Conversion Highlights:**
- Go binary doesn't need a runtime image — bind-mount the compiled binary
- Multi-stage: `go build` on host, then run in a `scratch` or `alpine` container
- Health-check via `/healthz` endpoint using `net/http`

**Start script:** `start-go-stack.sh`

## Template 5: Microservices Demo (Premium)

Four services simulating a real microservices architecture:

```
Gateway (nginx, :80)
├── Users API (Node.js, :3001) ─── Users DB (PostgreSQL, :5432)
├── Orders API (Go, :3002) ────── Orders DB (PostgreSQL, :5433)
├── Products API (Python, :3003) ─ Products DB (PostgreSQL, :5434)
└── Message Queue (Redis, :6379) — shared event bus
```

**Conversion Highlights:**
- Three PostgreSQL instances on separate ports — zero port collision (each has its own IP)
- Redis as shared event bus — all services connect to `redis.dev.internal:6379`
- Nginx routes by path: `/api/users/*` → users-api, `/api/orders/*` → orders-api, etc.
- Inter-service communication via HTTP + DNS: `users-api.dev.internal:3001`

**Start script:** `start-microservices-stack.sh`

## Template Customization Guide

Every template follows the same pattern. To swap in your own project:

1. **Replace the image** — change the image name in the start script
2. **Adjust environment variables** — update DNS hostnames from `service-name` to `container-name.dev.internal`
3. **Update the health-check endpoint** — change `/health` to your app's health route
4. **Run the start script** — `./start-<stack>.sh`

## Command Cheat Card (PDF)

A one-page quick-reference card is included in the downloads. Print it. Stick it on your monitor. Everything from `container run` flags to DNS patterns to common error fixes.

---

**Next: Chapter 5 — Named Volumes & Data.** Backup strategies, volume migration from Docker, and PostgreSQL data handling.
