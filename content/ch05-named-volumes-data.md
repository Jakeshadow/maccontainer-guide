# Chapter 5: Named Volumes & Data
**Status: Paid Content**

---

Data that survives a container restart. Backups that actually restore. Migrating a 50 GB PostgreSQL volume from Docker without three hours of downtime.

## Volume Architecture: Docker vs. Apple Container

In Docker Desktop on macOS, volumes live inside a Linux VM. Data travels:

```
Host Mac → Hypervisor → Linux VM → ext4 filesystem → Docker volume driver
```

Every read crosses four abstraction layers. This is why Docker volume I/O on macOS is 40-60% slower than native.

Apple Container volumes live directly on APFS:

```
Host Mac → APFS → Apple Container volume
```

One filesystem, no VM translation. The volume is a sparse disk image in `~/Library/Containers/Volumes/`. You can browse it in Finder. You can back it up with Time Machine. You can `cp -a` it to another Mac.

**Implication:** PostgreSQL `pg_dump` on a 10 GB database takes ~22 seconds on Apple Container vs. ~51 seconds on Docker Desktop (same hardware, M3 Pro, APFS encrypted). Chapter 8 has the full benchmark table.

## Named Volumes: Creation and Lifecycle

```bash
container volume create mydata
container volume ls
# NAME     SIZE      CREATED
# mydata   0 B      2026-06-29 14:22:01
```

Attach to a container:

```bash
container run --name db \
  --mount type=volume,src=mydata,dst=/var/lib/postgresql/data \
  postgres:16-alpine
```

Stop the container. Remove it. The volume survives:

```bash
container stop db
container rm db
container volume ls
# NAME     SIZE      CREATED
# mydata   1.2 GB    2026-06-29 14:22:01
```

Create a new container with the same volume — data is intact:

```bash
container run --name db2 \
  --mount type=volume,src=mydata,dst=/var/lib/postgresql/data \
  postgres:16-alpine
```

**Key difference from Docker:** Apple Container volumes are not garbage-collected. `container rm` never deletes volumes. `container volume prune` removes unused ones, but the default is "keep everything." This prevents the "I ran docker system prune and lost my database" accident.

## Bind Mount vs. Named Volume: Decision Matrix

| Factor | Bind Mount | Named Volume |
|--------|-----------|--------------|
| Host access | Direct — Finder, editor, `git` | Via `container volume export` (manual) |
| Performance | APFS native, ~identical | APFS native, ~identical |
| Container ownership | Chown needed on first run | Container owns it from start |
| Backup tooling | `rsync`, Time Machine, any tool | `container volume export` + `rsync` |
| Multi-container sharing | Possible but risky (concurrent writes) | Same risk — one writer at a time |
| Portability between Macs | `scp -r` or shared disk | `container volume export` → `scp` → `container volume import` |
| Docker→Apple Container migration | Bind mount the Docker volume path | Export from Docker, import to Apple Container |

**Rule of thumb — same as Docker:**
- **Bind mount:** Code you edit, config files, anything you want visible in Finder
- **Named volume:** Databases, queues, opaque application state the container owns

## Backup Strategies

### Strategy 1: Volume Export (Full Backup)

Apple Container's built-in export/import:

```bash
# Stop the container first — writing to a live database volume corrupts data
container stop db

# Export to a compressed tarball
container volume export mydata --output ~/backups/mydata-$(date +%Y%m%d).tar.gz

# Restore
container volume create mydata-restored
container volume import mydata-restored --input ~/backups/mydata-20260629.tar.gz
```

**Best for:** Weekly full backups, pre-upgrade snapshots, migrating to a new Mac.

**Caveat:** `container volume export` stops the container if it's running (with a warning). Don't rely on this — stop it yourself first.

### Strategy 2: Application-Level Dump (Consistent Backup)

For databases, the application's native dump tool is safer than filesystem-level snapshots:

```bash
#!/bin/bash
# backup-postgres.sh — consistent PostgreSQL dump from inside the container
set -euo pipefail

CONTAINER_NAME="db"
DB_NAME="myapp"
BACKUP_DIR="$HOME/backups/postgres"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

mkdir -p "$BACKUP_DIR"

# pg_dump from inside the container, pipe to host file
container exec "$CONTAINER_NAME" \
  pg_dump -U postgres -d "$DB_NAME" --clean --if-exists \
  > "$BACKUP_DIR/${DB_NAME}-${TIMESTAMP}.sql"

# Compress
gzip "$BACKUP_DIR/${DB_NAME}-${TIMESTAMP}.sql"

# Keep last 7 days
find "$BACKUP_DIR" -name "*.sql.gz" -mtime +7 -delete

echo "Backup: $BACKUP_DIR/${DB_NAME}-${TIMESTAMP}.sql.gz"
```

**Best for:** Daily database backups. Consistent even while the container runs.

### Strategy 3: Timed Snapshot with Health Check

```bash
#!/bin/bash
# safe-volume-backup.sh — health-check → stop → export → restart
set -euo pipefail

CONTAINER="db"
VOLUME="pgdata"
BACKUP_DIR="$HOME/backups/volumes"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# Verify container is healthy
if ! container exec "$CONTAINER" pg_isready -U postgres > /dev/null 2>&1; then
  echo "ERROR: PostgreSQL not healthy, aborting backup"
  exit 1
fi

# Graceful stop
container stop "$CONTAINER"

# Export
mkdir -p "$BACKUP_DIR"
container volume export "$VOLUME" --output "$BACKUP_DIR/${VOLUME}-${TIMESTAMP}.tar.gz"

# Restart
container start "$CONTAINER"

# Verify backup is non-empty
if [ ! -s "$BACKUP_DIR/${VOLUME}-${TIMESTAMP}.tar.gz" ]; then
  echo "ERROR: Backup file is empty"
  exit 1
fi

echo "Backup complete: $BACKUP_DIR/${VOLUME}-${TIMESTAMP}.tar.gz"
```

## Migrating PostgreSQL Data from Docker

Two paths. Pick based on downtime tolerance.

### Path A: pg_dump → pg_restore (Minimal Downtime)

Works while the Docker container is still running. No volume-level export needed.

```bash
# 1. Dump from Docker PostgreSQL
docker exec docker-postgres pg_dump -U postgres -d myapp --clean --if-exists \
  | gzip > ~/migration-dump.sql.gz

# 2. Create Apple Container volume and start fresh PostgreSQL
container volume create pgdata
container run --name db --machine app-stack \
  --mount type=volume,src=pgdata,dst=/var/lib/postgresql/data \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD=yourpass \
  postgres:16-alpine

# 3. Wait for PostgreSQL to be ready
until container exec db pg_isready -U postgres; do sleep 1; done

# 4. Restore
gunzip -c ~/migration-dump.sql.gz | container exec -i db psql -U postgres -d myapp
```

**Downtime:** The restore step takes minutes (depends on data size). Docker container keeps serving reads during dump.

### Path B: Volume-Level Migration (Large Databases)

For databases > 10 GB where pg_dump/restore takes too long:

```bash
# 1. Export from Docker (Docker Desktop volumes live in the Linux VM)
docker run --rm -v docker_pgdata:/data -v $(pwd):/backup \
  alpine tar czf /backup/pgdata-docker.tar.gz -C /data .

# 2. Create Apple Container volume
container volume create pgdata

# 3. Start a temporary container with the volume mounted, extract into it
container run --rm \
  --mount type=volume,src=pgdata,dst=/var/lib/postgresql/data \
  --mount type=bind,src=$(pwd),dst=/backup \
  alpine tar xzf /backup/pgdata-docker.tar.gz -C /var/lib/postgresql/data
```

**Caveat:** Path B assumes PostgreSQL versions match and the data directory format is compatible. Test on a staging copy first. Path A (pg_dump) is always safer for cross-platform migration.

## Automated Nightly Backup with launchd

Chapter 6 covers launchd in depth. Here's the backup-specific plist:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.myapp.pgbackup</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/yourname/scripts/backup-postgres.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>2</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/yourname/Library/Logs/pgbackup.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/yourname/Library/Logs/pgbackup-error.log</string>
</dict>
</plist>
```

Load it:

```bash
cp com.myapp.pgbackup.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.myapp.pgbackup.plist
```

## Volume Inspection and Debugging

Find where a volume lives on disk:

```bash
container volume inspect mydata
# "path": "/Users/yourname/Library/Containers/Volumes/mydata"
```

Browse it in Finder:

```bash
open $(container volume inspect mydata | grep path | cut -d'"' -f4)
```

Check volume size:

```bash
du -sh ~/Library/Containers/Volumes/mydata
```

## Multi-Volume Setups

PostgreSQL performance tip: separate data and WAL onto different volumes. WAL writes are sequential; data writes are random. APFS handles both fine, but for write-heavy workloads, splitting them avoids contention:

```bash
container volume create pgdata
container volume create pgwal

container run --name db \
  --mount type=volume,src=pgdata,dst=/var/lib/postgresql/data \
  --mount type=volume,src=pgwal,dst=/var/lib/postgresql/data/pg_wal \
  --env "POSTGRES_INITDB_ARGS=--waldir=/var/lib/postgresql/data/pg_wal" \
  postgres:16-alpine
```

---

**Next: Chapter 6 — Production Hardening.** launchd auto-start, TLS termination, resource limits, and log rotation.
