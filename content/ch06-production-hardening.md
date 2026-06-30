# Chapter 6: Production Hardening
**Status: Paid Content**

---

You've got a stack running. Now make it survive reboots, handle TLS, not eat all your RAM, and tell you when something breaks.

## launchd: Auto-Start on Boot

Apple Container has no equivalent of Docker's `restart: always`. The macOS-native replacement is `launchd` — the same system that starts every macOS daemon.

### Single Container: Minimal plist

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.myapp.nginx</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/container</string>
    <string>run</string>
    <string>--name</string>
    <string>nginx</string>
    <string>--mount</string>
    <string>type=bind,src=/Users/yourname/nginx.conf,dst=/etc/nginx/nginx.conf</string>
    <string>nginx:alpine</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/yourname/Library/Logs/nginx.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/yourname/Library/Logs/nginx-error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
```

Install:

```bash
cp com.myapp.nginx.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.myapp.nginx.plist
```

**What this gives you:**
- `RunAtLoad` — starts on boot
- `KeepAlive` — restarts the container if it exits (covers crashes, OOM kills)
- Logs go to `~/Library/Logs/` — not lost on terminal close

### Full Stack: Startup Script + launchd

For a multi-container stack, write a start script (Chapter 3) and have launchd call that:

```xml
<key>ProgramArguments</key>
<array>
  <string>/Users/yourname/scripts/start-app-stack.sh</string>
</array>
```

The script handles startup order, health checks, and DNS waits. launchd handles "run this at boot and restart it if it dies."

**Testing your plist:**

```bash
# Check syntax
plutil -lint ~/Library/LaunchAgents/com.myapp.nginx.plist

# Start immediately (bypasses boot-only timing)
launchctl start com.myapp.nginx

# Check it's running
launchctl list | grep com.myapp.nginx

# Tail logs
tail -f ~/Library/Logs/nginx.log
```

### launchd vs. Docker restart Policies

| Docker | launchd |
|--------|---------|
| `restart: always` | `KeepAlive` + `RunAtLoad` |
| `restart: unless-stopped` | `KeepAlive` (manually unload to stop) |
| `restart: on-failure` | `KeepAlive` (successful exit stops; use `SuccessfulExit` key to control) |
| `restart: no` | Omit `KeepAlive` |

### Graceful Shutdown on System Reboot

launchd sends SIGTERM to the container process on system shutdown. Apple Container translates this to a `container stop` (SIGTERM to the container's init process, then SIGKILL after 10s). No special handling needed — but make sure your app handles SIGTERM.

Test it:

```bash
# Simulate system shutdown signal
launchctl unload ~/Library/LaunchAgents/com.myapp.nginx.plist
# Watch logs to verify graceful shutdown
tail -f ~/Library/Logs/nginx.log
```

## TLS Termination with Nginx

Apple Container has no built-in TLS. The standard pattern: Nginx container terminates TLS, proxies to backend containers over the internal network.

### Step 1: Get a Certificate

Use Certbot on the host Mac (not inside a container):

```bash
brew install certbot
sudo certbot certonly --standalone -d api.maccontainer.dev
```

Certificates land in `/etc/letsencrypt/live/api.maccontainer.dev/`.

### Step 2: Bind-Mount Certs into Nginx Container

```bash
container run --name nginx --machine my-stack \
  --mount type=bind,src=/etc/letsencrypt,dst=/etc/letsencrypt,readonly=true \
  --mount type=bind,src=$(pwd)/nginx.conf,dst=/etc/nginx/nginx.conf \
  nginx:alpine
```

### Step 3: nginx.conf

```nginx
events { worker_connections 1024; }

http {
  # Redirect HTTP → HTTPS
  server {
    listen 80;
    server_name api.maccontainer.dev;
    return 301 https://$host$request_uri;
  }

  server {
    listen 443 ssl;
    server_name api.maccontainer.dev;

    ssl_certificate     /etc/letsencrypt/live/api.maccontainer.dev/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.maccontainer.dev/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    location / {
      proxy_pass http://api.dev.internal:3000;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
    }
  }
}
```

### Step 4: Auto-Renew with launchd

Certbot certs expire after 90 days. Automate renewal:

```bash
#!/bin/bash
# renew-certs.sh
set -euo pipefail

# Renew
certbot renew --quiet --post-hook "container exec nginx nginx -s reload"
```

launchd plist (runs daily at 3am):

```xml
<key>StartCalendarInterval</key>
<dict>
  <key>Hour</key><integer>3</integer>
  <key>Minute</key><integer>0</integer>
</dict>
```

## Resource Limits

### CPU Limits

```bash
container run --cpu-limit 2 myapp:latest   # 2 virtual cores max
container run --cpu-limit 0.5 myapp:latest # half a core
```

CPU limits are enforced by Virtualization.framework at the hypervisor level. A container hitting its limit just runs slower — no kill signal. This is cleaner than Docker's `--cpus` which uses CFS quota and can cause throttle spikes.

**Recommendation:** Start with `--cpu-limit 1` for most services. Monitor with `top` inside the container. Bump to 2 for Node.js (event loop can benefit from a second core for GC). Leave at 0.5 for sidecars (Redis, small nginx).

### Memory Limits

```bash
container run --memory-limit 512M myapp:latest
container run --memory-limit 2G myapp:latest
```

When a container exceeds its memory limit, Virtualization.framework kills the VM — same effect as Docker's OOM kill. The container stops. If you're using `launchd` with `KeepAlive`, it restarts automatically.

**Memory sizing rules:**
- **PostgreSQL:** 25% of host RAM for `shared_buffers`, plus 256 MB overhead. 16 GB Mac → `--memory-limit 3G` minimum.
- **Node.js:** Heap defaults to 512 MB (64-bit). `--memory-limit 1G` is a safe default for most API workloads.
- **Go:** Binary is typically < 20 MB. `--memory-limit 128M` is plenty for most Go services.
- **Redis:** `--memory-limit 256M` covers 99% of use cases. Redis is memory-efficient.

### Finding Actual Usage

```bash
# Host-side: check VM resource consumption
container inspect myapp | grep -E "memory|cpu"

# Inside container: standard Linux tools work
container exec myapp free -h
container exec myapp top -bn1 | head -5
```

## Log Rotation

Apple Container logs to `~/Library/Containers/Logs/` by default. These files grow indefinitely. Set up `newsyslog` (macOS's built-in log rotator):

```conf
# /etc/newsyslog.d/container.conf
/Users/yourname/Library/Logs/nginx.log    644  7  1024  *  J
/Users/yourname/Library/Logs/nginx-error.log  644  7  1024  *  J
/Users/yourname/Library/Logs/api.log      644  7  2048  *  J
```

This rotates logs weekly (`*`), keeps 7 archives, triggers at 1 MB (`1024` in KB), and compresses with bzip2 (`J`).

For containers writing logs internally (app logs in `/var/log/app/`), bind-mount that directory to a host path and rotate the host path:

```bash
container run --name api \
  --mount type=bind,src=$HOME/Library/Logs/myapp,dst=/var/log/app \
  ...
```

## Health Monitoring

### Container-Level Health Check

```bash
# Quick check: is the container running?
container ps --filter name=api --filter status=running

# Deeper check: is the app responding?
container exec api curl -sf http://localhost:3000/health || exit 1
```

Wrap in a monitoring script triggered by launchd every 60 seconds:

```xml
<key>StartInterval</key>
<integer>60</integer>
```

```bash
#!/bin/bash
# health-monitor.sh
if ! container exec api curl -sf http://localhost:3000/health > /dev/null 2>&1; then
  echo "[$(date)] api health check FAILED — restarting" >> ~/Library/Logs/health-monitor.log
  container restart api
fi
```

### External Monitoring

For serious production use, point an external monitor (Better Uptime, UptimeRobot, or a cron job on another machine) at your Nginx health endpoint. The internal health check catches crashes; the external one catches "the Mac went to sleep" or "the internet is down."

## The Production Checklist

Before calling it "production," verify every item:

- [ ] `launchd` plist installed and loaded for every container
- [ ] `KeepAlive` set on every plist
- [ ] TLS cert auto-renews via cron/launchd
- [ ] Memory and CPU limits set on every container
- [ ] Log rotation configured for all log directories
- [ ] Health check endpoint exists and returns 200 (not just listening — actually healthy)
- [ ] Health monitor script runs on a timer
- [ ] Reboot test: restart your Mac. Does the stack come back without manual intervention?
- [ ] Backup test: can you restore the latest backup to a fresh container?

---

**Next: Chapter 7 — Security & Networking.** Network isolation, VPN-friendly DNS, private registries, and secrets management.
