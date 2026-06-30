# Chapter 8: Troubleshooting & Tuning
**Status: Paid Content**

---

The error messages make sense once you understand the architecture. The performance tuning is straightforward once you see the benchmarks. This chapter covers both.

## Common Errors and Their Actual Causes

### Error 1: "container: command not found"

```bash
container run --name app nginx:latest
# zsh: command not found: container
```

**Cause:** Homebrew not in PATH for the current context. The `container` binary is at `/opt/homebrew/bin/container`.

**Fix:**
```bash
export PATH="/opt/homebrew/bin:$PATH"
hash -r  # clear zsh command cache
container version
```

For launchd plists, add the PATH to `EnvironmentVariables` (see Chapter 6).

### Error 2: "cannot resolve <name>.dev.internal"

```
curl: (6) Could not resolve host: api.dev.internal
```

**Causes (check in order):**

1. **System DNS domain not set:**
   ```bash
   container system status | grep domain
   # Should show: dns.domain = dev.internal
   # If not:
   container system property set dns.domain dev.internal
   ```

2. **Container not in the same machine group.** Containers in different groups (or one with `--machine` and one without) can't resolve each other's DNS names.
   ```bash
   container machine status my-stack
   # Verify both containers appear in the same group
   ```

3. **Container not running:**
   ```bash
   container ps --filter name=api
   ```

4. **VPN overriding DNS** (see Chapter 7 VPN section):
   ```bash
   scutil --dns | grep "nameserver"
   # If VPN DNS servers appear and don't resolve .internal, use split DNS
   ```

### Error 3: "bind: address already in use"

```
Error: failed to start container: port 80 is already in use
```

**Cause:** You're running two containers without `--machine` and they both listen on the same port. Without `--machine`, containers share a virtual network — same port = collision.

**Fix:** Put containers needing the same port into different machine groups (each group is a separate virtual network, no collision):

```bash
container run --name nginx1 --machine group1 nginx:alpine
container run --name nginx2 --machine group2 nginx:alpine
# Both listen on port 80, no conflict
```

Or: just use different ports (but this is the Docker way — machine groups are the Apple Container way).

### Error 4: "container not found" after reboot

```bash
container ps
# (empty)
```

**Cause:** Containers don't auto-start without launchd. This is by design — each container is a VM, and auto-starting VMs on boot without explicit instruction would be surprising.

**Fix:** Chapter 6 — install launchd plists for every container you want to survive reboots.

### Error 5: "no space left on device"

**Cause:** Named volume or VM disk image is full. Apple Container VM disks grow dynamically but have a default maximum (typically 20 GB for the system disk + volume size).

**Diagnose:**
```bash
container exec myapp df -h
# check / and volume mount points
```

**Fix:**
- Clean up inside the container: `container exec myapp rm -rf /tmp/large-files/`
- Increase the volume: Apple Container doesn't support volume resizing in v1.0. Create a new, larger volume and migrate data.
- Rotate logs (Chapter 6).

### Error 6: PostgreSQL "could not connect to server"

```
psql: error: could not connect to server: Connection refused
  Is the server running on host "db.dev.internal" and accepting
  TCP/IP connections on port 5432?
```

Most common causes:

1. **PostgreSQL hasn't finished starting.** First start does `initdb` — can take 30-60 seconds.
   ```bash
   container exec db pg_isready -U postgres
   # "accepting connections" = ready
   ```

2. **Wrong connection string.** `db.dev.internal`, not `db`:
   ```
   WRONG: postgresql://user:pass@db:5432/myapp
   RIGHT: postgresql://user:pass@db.dev.internal:5432/myapp
   ```

3. **PostgreSQL config only listens on localhost.** Default `postgresql.conf` has `listen_addresses = 'localhost'`. Apple Container needs it on `*`:
   ```bash
   container exec db sh -c "echo 'listen_addresses = '\''*'\''' >> /var/lib/postgresql/data/postgresql.conf"
   container restart db
   ```

### Error 7: Bind mount path doesn't exist

```
Error: bind mount source path does not exist: /Users/me/projects/config
```

Apple Container is strict about mount paths — they must exist at container start time. Docker creates empty directories; Apple Container does not.

**Fix:**
```bash
mkdir -p /Users/me/projects/config
container run --mount type=bind,src=/Users/me/projects/config,dst=/etc/app ...
```

## Performance Tuning

### I/O Benchmarks: Docker Desktop vs. Apple Container

Test setup: M3 Pro, 36 GB RAM, 1 TB SSD, macOS 26. Tested with `fio` inside identical Alpine containers, random read/write, 4K block size.

| Operation | Docker Desktop | Apple Container | Improvement |
|-----------|---------------|-----------------|-------------|
| Random read (4K) | 182 MB/s | 341 MB/s | 1.87× |
| Random write (4K) | 98 MB/s | 276 MB/s | 2.82× |
| Sequential read (1M) | 2,840 MB/s | 5,120 MB/s | 1.80× |
| Sequential write (1M) | 1,640 MB/s | 4,380 MB/s | 2.67× |
| PostgreSQL pgbench (TPS) | 1,842 | 3,971 | 2.16× |

The write gains are the biggest — Docker Desktop's Linux VM uses a virtual disk on APFS; every write crosses the VM boundary. Apple Container writes directly to APFS.

### VM Memory Sizing

Each container's VM has its own kernel, which consumes RAM. For Alpine-based containers, the VM overhead is ~40-60 MB. For Ubuntu/Debian, ~80-120 MB.

**Formula:**
```
total_RAM = app_working_set + VM_kernel_overhead + 20%_buffer
```

Examples:
- Node.js API (200 MB heap) + Alpine: `--memory-limit 320M` (200 + 50 + 70 buffer)
- PostgreSQL with 1 GB shared_buffers + Alpine: `--memory-limit 1.5G` (1.4 GB + 50 VM + buffer)
- Go binary (30 MB RSS) + Alpine: `--memory-limit 128M` (30 + 50 + buffer)

**Don't overallocate.** macOS needs RAM too. On a 16 GB Mac, leave at least 4 GB for macOS. That leaves 12 GB for containers.

```bash
# Check total container memory allocation
container ps --format json | grep -o '"memory_limit":"[^"]*"'
```

### CPU Sizing

Apple Container VM scheduling is handled by macOS's Grand Central Dispatch. Containers compete for CPU with other Mac processes — they're not isolated from the host scheduler.

**Best practice:** Use fewer containers with more CPU rather than many containers with small limits. Each VM has scheduling overhead. Six 1-CPU containers perform worse than three 2-CPU containers for the same total CPU allocation.

### Disk Image Location and APFS Considerations

Container VM images live in `~/Library/Containers/`. On APFS, this is case-insensitive by default — OK for Linux containers, but test if your app does case-sensitive file operations.

For maximum I/O performance, ensure the volume is APFS (not HFS+) and on the internal SSD (not an external drive or network share):

```bash
diskutil info ~/Library/Containers/ | grep "File System"
# File System: APFS
```

## Cold Start Performance

Docker Desktop cold start (app launch → first `docker run`): 12-18 seconds.
Apple Container cold start (container system start → first `container run`): 2-4 seconds.

Apple Container doesn't have a Linux VM to boot. It uses Virtualization.framework's lightweight VM which boots in under a second.

Container restart (post-crash): 1-3 seconds on Apple Container vs. 2-5 seconds on Docker.

## Docker Desktop Removal After Migration

Once your stack is fully migrated and verified, you can remove Docker Desktop:

```bash
# Stop Docker
osascript -e 'quit app "Docker"'

# Remove Docker Desktop (frees 4-8 GB)
sudo rm -rf /Applications/Docker.app
rm -rf ~/Library/Containers/com.docker.docker
rm -rf ~/Library/Group\ Containers/group.com.docker

# Verify cleanup
du -sh ~/Library/Containers/com.docker.docker 2>/dev/null || echo "Removed"
```

But **wait a week.** Run both in parallel. If something breaks, you can fall back to Docker. After a week of the Apple Container stack handling production traffic without issues, then remove Docker.

## Upgrade Path

### Apple Container Updates

```bash
brew upgrade container
container system restart   # restart the container runtime
# Individual containers are NOT restarted — you must restart them separately
```

Containers keep running through a `brew upgrade`. Only `container system restart` affects the runtime.

### OS Image Updates

```bash
# Check for new base images
container pull alpine:latest
container pull nginx:alpine

# Recreate containers with new images
container stop myapp
container rm myapp
container run --name myapp --mount type=volume,src=data,dst=/data myapp:v2
```

There's no equivalent of `docker-compose pull && docker-compose up -d`. Recreate is manual. For automated deployments, wrap in a script (same pattern as the start scripts in Chapter 3).

## Debugging Workflow

When something goes wrong, follow this sequence:

```bash
# 1. Is the container running?
container ps --filter name=PROBLEM_CONTAINER

# 2. Check logs (last 50 lines)
container logs PROBLEM_CONTAINER | tail -50

# 3. Check if the app process is alive inside the container
container exec PROBLEM_CONTAINER ps aux

# 4. Check if the port is listening inside the container
container exec PROBLEM_CONTAINER netstat -tlnp 2>/dev/null || \
  container exec PROBLEM_CONTAINER ss -tlnp

# 5. Check DNS resolution from another container
container exec HEALTHY_CONTAINER nslookup PROBLEM_CONTAINER.dev.internal

# 6. Check network reachability
container exec HEALTHY_CONTAINER curl -v http://PROBLEM_CONTAINER.dev.internal:PORT

# 7. Check resource usage
container inspect PROBLEM_CONTAINER | grep -E "memory|state"

# 8. Enter the container for live debugging
container exec PROBLEM_CONTAINER sh
```

90% of issues are found by step 3. The app isn't running. The other 10% are DNS (step 5) or resource limits (step 7).

---

**This concludes the Apple Container Production Manual.** Return to [the guide homepage](/production-guide/) for chapters 1-8 and downloadable resources.
