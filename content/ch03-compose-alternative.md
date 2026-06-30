# Chapter 3: Compose Alternative
**Status: Paid Content**

---

This is the chapter that justifies this manual. Compose is the #1 requested feature for Apple Container. It doesn't exist. But Container Machines do.

## Container Machines: The Conceptual Model

A Container Machine is a group of containers that share a virtual network. Think of it as a docker-compose project — all containers in the group can reach each other by DNS name, share the same DNS domain, and are managed as a unit.

```
docker-compose project   →  Container Machine
docker-compose services  →  Containers in the machine group
service-name resolution  →  <name>.dev.internal DNS
depends_on               →  Shell script startup order
```

## Architecture: How It Actually Works

```
192.168.0.100 (Host Mac)
└── Virtualization.framework
    └── Virtual Network (10.0.0.0/24, configurable)
        ├── Container web (10.0.0.2) ─── nginx:alpine
        ├── Container api (10.0.0.3) ─── node:22-alpine
        └── Container db  (10.0.0.4) ─── postgres:16-alpine

DNS: api.dev.internal → 10.0.0.3
     db.dev.internal  → 10.0.0.4
     web.dev.internal → 10.0.0.2
```

Every container in the machine group can reach every other container at `<name>.dev.internal:<port>`. No port mapping. No service name hack. Just DNS.

## Creating a Machine Group

```bash
container machine create my-stack
```

This creates an empty group. Containers added with `--machine` join it:

```bash
container run --name api --machine my-stack --env PORT=3000 myapp:latest
container run --name db  --machine my-stack postgres:16-alpine
```

Check status:
```bash
container machine status my-stack
# MACHINE    CONTAINER  STATUS    IP
# my-stack   api        running   10.0.0.2
# my-stack   db         running   10.0.0.3
```

## docker-compose.yml → Container Machine: Complete Mapping

### The Original

```yaml
version: '3'
services:
  web:
    build: ./frontend
    ports:
      - "3000:3000"
    environment:
      - API_URL=http://api:4000
    depends_on:
      - api

  api:
    build: ./backend
    ports:
      - "4000:4000"
    environment:
      - DATABASE_URL=postgresql://user:pass@db:5432/app
    volumes:
      - ./uploads:/app/uploads
    depends_on:
      - db

  db:
    image: postgres:16-alpine
    environment:
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=pass
      - POSTGRES_DB=app
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

### The Conversion

#### 1. Named Volume

```bash
container volume create pgdata
```

#### 2. Machine Group

```bash
container machine create app-stack
```

#### 3. Database

```bash
container run --name db --machine app-stack \
  --env POSTGRES_USER=user \
  --env POSTGRES_PASSWORD=pass \
  --env POSTGRES_DB=app \
  --mount type=volume,src=pgdata,dst=/var/lib/postgresql/data \
  postgres:16-alpine
```

#### 4. API (after DB is ready)

```bash
# Wait for PostgreSQL
until curl -s http://db.dev.internal:5432 > /dev/null 2>&1; do sleep 1; done

container run --name api --machine app-stack \
  --env "DATABASE_URL=postgresql://user:pass@db.dev.internal:5432/app" \
  --env "API_URL=http://api.dev.internal:4000" \
  --mount type=bind,src=$(pwd)/uploads,dst=/app/uploads \
  api-image:latest
```

#### 5. Web Frontend

```bash
container run --name web --machine app-stack \
  --env "API_URL=http://api.dev.internal:4000" \
  web-image:latest
```

### Key Changes in Environment Variables

| Original (docker-compose) | Converted (Apple Container) |
|---------------------------|----------------------------|
| `host=db` | `host=db.dev.internal` |
| `host=api` | `host=api.dev.internal` |
| `http://api:4000` | `http://api.dev.internal:4000` |
| `postgresql://user:pass@db:5432/db` | `postgresql://user:pass@db.dev.internal:5432/db` |

**Rule:** Every `service-name` in docker-compose becomes `<container-name>.dev.internal` in Apple Container.

## Startup Order: The Shell Script Pattern

The `depends_on` logic becomes an explicit shell script. Here's the production-grade version:

```bash
#!/bin/bash
# start-app-stack.sh
set -euo pipefail
DIR=$(cd "$(dirname "$0")" && pwd)

log() { echo "[$(date +%H:%M:%S)] $*"; }
wait_for_port() {
  local host=$1 port=$2 timeout=${3:-30}
  local start=$(date +%s)
  log "Waiting for $host:$port..."
  while ! curl -s "http://$host:$port" > /dev/null 2>&1; do
    if [ $(($(date +%s) - start)) -ge $timeout ]; then
      log "ERROR: $host:$port did not respond within ${timeout}s"
      return 1
    fi
    sleep 1
  done
  log "$host:$port is ready"
}

# Create machine group (idempotent)
container machine create app-stack 2>/dev/null || true

# --- Start DB ---
log "Starting PostgreSQL"
container run --name db --machine app-stack \
  --env POSTGRES_USER=user \
  --env POSTGRES_PASSWORD=pass \
  --env POSTGRES_DB=app \
  --mount type=volume,src=pgdata,dst=/var/lib/postgresql/data \
  postgres:16-alpine

wait_for_port db.dev.internal 5432 30

# --- Start API ---
log "Starting API"
container run --name api --machine app-stack \
  --env "DATABASE_URL=postgresql://user:pass@db.dev.internal:5432/app" \
  --mount type=bind,src=$DIR/backend,dst=/app \
  api-image:latest

wait_for_port api.dev.internal 4000 10

# --- Start Web ---
log "Starting Web"
container run --name web --machine app-stack \
  --env "API_URL=http://api.dev.internal:4000" \
  web-image:latest

log "Stack running"
container machine status app-stack
```

## Docker Compose Features and Their Replacements

| Compose Feature | Apple Container Replacement |
|----------------|---------------------------|
| `depends_on` with `condition: service_healthy` | `wait_for_port` in shell script (above) |
| `restart: always` | `launchd` plist (Chapter 6) |
| `env_file:` | `--env-file` flag |
| `extends:` | Source a shared `env.sh` in your start script |
| `profiles:` | Separate start scripts per profile |
| `networks:` with aliases | All containers in a machine share DNS — aliases not needed |
| `secrets:` | Environment variables sourced from a `secrets.sh` (gitignored) |
| `deploy.resources.limits` | `--memory-limit` and `--cpu-limit` flags |

## Multi-Network Topologies

Docker Compose lets you define isolated networks. Apple Container doesn't have named networks, but you can achieve isolation with multiple machine groups:

```bash
# Frontend can reach API, but DB is isolated
container machine create frontend-group
container machine create data-group

# web and api in frontend group — can reach each other
container run --name web --machine frontend-group ...
container run --name api --machine frontend-group ...

# db in data group — isolated from frontend
container run --name db --machine data-group ...
```

The API container can be in both groups (just rerun with the second `--machine` flag), acting as a bridge.

## Limitations and Workarounds

**No `docker-compose down`.** Stop and remove manually:
```bash
container machine stop my-stack    # stop all
container rm web api db           # remove containers
```

**No `docker-compose logs -f`.** Tail logs per container:
```bash
container logs -f api &
container logs -f web &
```

**No `docker-compose up --build`.** Build images separately:
```bash
docker build -t api-image:latest ./backend   # or use container build
```

---

**Next: Chapter 4 — Stack Templates.** Five complete stacks, converted and ready to run.
