# Chapter 2: Single Container Migration
**Status: Free Preview**

---

How to take a single Docker container and run it on Apple Container — with every flag mapped correctly.

## Environment Variables

Docker:
```bash
docker run -d --name app -e NODE_ENV=production -e PORT=3000 myapp:latest
```

Apple Container:
```bash
container run --name app --env NODE_ENV=production --env PORT=3000 myapp:latest
```

Use `--env-file` to load from a file — identical behavior to Docker:

```bash
container run --name app --env-file .env.production myapp:latest
```

## Ports and Networking

The biggest conceptual shift: **no port mapping needed.**

In Docker, containers share the host's network. You expose ports with `-p`:

```bash
docker run -d -p 8080:80 nginx:latest
# nginx available at http://localhost:8080
```

In Apple Container, each container has its own IP on a private virtual network:

```bash
container run --name nginx nginx:latest
# nginx available at http://nginx.dev.internal (port 80, the container's native port)
```

**Implication:** Multiple containers can all listen on port 80 (or any port) without conflict. Each has its own IP. This eliminates the port collision problem that plagues Docker setups with `-p 80:80 -p 443:443` across multiple services.

### When you need the container IP directly

```bash
container inspect nginx | grep IP
# "ip": "10.0.0.5"
```

## Volumes: Bind Mounts and Named Volumes

### Bind Mounts

Docker:
```bash
docker run -v $(pwd)/data:/app/data myapp:latest
```

Apple Container:
```bash
container run --mount type=bind,src=$(pwd)/data,dst=/app/data myapp:latest
```

Bind mounts work identically — the host directory is available inside the container. Performance is better on Apple Container because it uses native APFS without a VM translation layer.

### Named Volumes

Docker:
```bash
docker volume create mydata
docker run -v mydata:/var/lib/data myapp:latest
```

Apple Container:
```bash
container volume create mydata
container run --mount type=volume,src=mydata,dst=/var/lib/data myapp:latest
```

Named volumes persist across container restarts. List them:
```bash
container volume ls
```

### Which to use?

- **Bind mount** — development, hot-reload, config files, anything you edit from the host
- **Named volume** — databases, persistent state, anything the container owns

Same logic as Docker. No surprises.

## Working Directory

Docker's `-w` / `--workdir`:
```bash
docker run -w /app myapp:latest
```

Apple Container uses `--working-dir`:
```bash
container run --working-dir /app myapp:latest
```

## Entrypoint and Command Override

Docker:
```bash
docker run --entrypoint /bin/sh myapp:latest -c "echo hello"
```

Apple Container:
```bash
container run --entrypoint /bin/sh myapp:latest -c "echo hello"
```

Identical syntax. The command after the image name is passed to the entrypoint.

## Resource Limits

Docker:
```bash
docker run --memory 512m --cpus 2 myapp:latest
```

Apple Container:
```bash
container run --memory-limit 512M --cpu-limit 2 myapp:latest
```

Each container's VM gets the specified resources. The Virtualization.framework enforces limits at the hypervisor level — more reliable than Docker's cgroup-based limits on macOS (which run inside a Linux VM anyway).

## Stopping and Removing

```bash
container stop app     # graceful shutdown (SIGTERM, then SIGKILL after 10s)
container kill app     # immediate SIGKILL
container rm app       # remove stopped container
container rm -f app    # force remove even if running
```

## Full Migration Example: Redis

Take this Docker command:
```bash
docker run -d --name redis-cache \
  -p 6379:6379 \
  -v redis-data:/data \
  -e REDIS_PASSWORD=mysecret \
  --memory 256m \
  redis:7-alpine redis-server --requirepass mysecret
```

Apple Container equivalent:
```bash
container volume create redis-data

container run --name redis-cache \
  --mount type=volume,src=redis-data,dst=/data \
  --env REDIS_PASSWORD=mysecret \
  --memory-limit 256M \
  redis:7-alpine redis-server --requirepass mysecret
```

Access at `http://redis-cache.dev.internal:6379` — no port mapping needed.

---

**You're ready for Chapter 3:** Compose Alternative — the heart of this manual.
