# Chapter 1: Installation & First Container
**Status: Free Preview**

---

## Prerequisites

- macOS 26 or later
- Apple Silicon Mac (M1/M2/M3/M4)
- Homebrew installed
- Terminal access

## Step 1: Install Apple Container

```bash
brew install container
```

Verify:

```bash
container version
```

## Step 2: Start the Container System

```bash
container system start
```

You'll be prompted for your password once. Apple Container uses it to create VMs via Virtualization.framework. After the first run, it starts automatically on login.

```bash
container system status
```

## Step 3: Configure DNS

Each container gets its own IP on a virtual network. Set the DNS domain for inter-container communication:

```bash
container system property set dns.domain dev.internal
```

Containers reach each other at `<container-name>.dev.internal` — no port mapping required.

## Step 4: Pull and Run Your First Container

```bash
container pull nginx:latest
container run --name my-nginx nginx:latest
container ps
```

Access at `http://my-nginx.dev.internal` or via the container's IP.

## Docker to Apple Container Command Reference

| Action | Docker | Apple Container |
|--------|--------|-----------------|
| List containers | `docker ps` | `container ps` |
| Run a container | `docker run -d --name X image` | `container run --name X image` |
| Stop | `docker stop X` | `container stop X` |
| Remove | `docker rm X` | `container rm X` |
| Logs | `docker logs X` | `container logs X` |
| Exec in container | `docker exec -it X sh` | `container exec X sh` |
| Pull image | `docker pull image` | `container pull image` |
| List images | `docker images` | `container images` |
| Bind mount | `-v /host:/container` | `--mount type=bind,src=/host,dst=/container` |
| Named volume | `-v vol:/path` | `--mount type=volume,src=vol,dst=/path` |
| Environment var | `-e KEY=val` | `--env KEY=val` |

## Key Differences at a Glance

**No port mapping.** Each Apple Container container has its own IP. `-p 8080:80` in Docker becomes direct access at `http://<container-name>.dev.internal:80`.

**No daemon mode flag.** Apple Container runs containers in the foreground by default. To background, use `container run --name X image &` or wrap in `launchd`.

**DNS, not service names.** Docker Compose resolves `db` to the database container. Apple Container resolves `postgres-db.dev.internal` — the full DNS name replaces service-name resolution.

---

**You're ready for Chapter 2:** Single Container Migration — environment variables, volumes, networking, and Docker-to-Apple Container mapping in depth.
