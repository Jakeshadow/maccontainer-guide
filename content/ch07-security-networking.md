# Chapter 7: Security & Networking
**Status: Paid Content**

---

Apple Container runs each container as a separate VM on a virtual network. This is architecturally more isolated than Docker's shared-kernel model. But it also means networking works differently — and the security model has different sharp edges.

## Security Model: VM Isolation vs. Shared Kernel

**Docker on macOS:**
```
All containers → shared Linux VM → shared kernel
  - Vulnerability in kernel = all containers compromised
  - Container escape ≈ host access (inside the Linux VM)
```

**Apple Container:**
```
Each container → independent VM → independent kernel
  - Kernel vulnerability = that one container compromised
  - Container escape ≠ automatic cross-container access
  - Each VM kernel is a separate attack surface
```

The security boundary is Virtualization.framework, the same hypervisor used by production macOS VMs. Apple ships security patches for it in macOS point releases.

**Implication:** You can run untrusted images with more confidence. A `:latest` pull that ships a compromised binary can't escape the VM to access other containers or the host filesystem directly — it has to break Virtualization.framework first.

## Network Isolation Patterns

### Default: All Containers on One Network

Without `--machine`, each container gets an IP on a shared virtual network:

```bash
container run --name app1 myapp:latest
container run --name app2 other-app:latest
# app1 can reach app2 at app2.dev.internal
```

This is convenient but means every container can reach every other container. For most single-machine setups this is fine — you trust all your own containers. For stricter isolation, use machine groups.

### Pattern 1: Machine Group Isolation

Containers in different machine groups cannot reach each other:

```bash
container machine create frontend
container machine create backend

container run --name nginx --machine frontend nginx:alpine
container run --name api --machine backend myapi:latest
# nginx CANNOT reach api by DNS — different networks
```

Each machine group creates a separate virtual network. No routing between groups by default.

### Pattern 2: Bridge Container

For intentional cross-group communication, put a container in both groups:

```bash
container run --name api --machine frontend --machine backend myapi:latest
```

The API container has network interfaces in both groups. It can route traffic between them (if your application implements that logic). Apple Container doesn't do forwarding automatically — your app decides what crosses groups.

### Pattern 3: Host-Only Mode

Need a container that CANNOT reach the internet? (Payment processing, local key management, offline data processing):

```bash
container run --name isolated --network host-only myapp:latest
```

The container can reach the host Mac and other containers on the same machine group, but has no route to the public internet.

### Pattern 4: Expose to LAN

Want other devices on your local network to reach a container?

```bash
container run --name dashboard --network bridge --port-forward 8080:3000 myapp:latest
```

This creates a port forward from the Mac's network interface to the container. Other devices on your LAN can access `http://<mac-ip>:8080`. Use sparingly — prefer nginx reverse proxy for anything beyond dev/debugging.

## DNS Configuration Deep Dive

Chapter 1 set up `.dev.internal`. Here's the full DNS picture.

### The Resolver

Apple Container runs a lightweight DNS server on the host. When a container resolves `api.dev.internal`, the request goes:

```
Container → DNS query → Host DNS resolver → checks container registry → returns IP
```

This resolver is what makes `<name>.dev.internal` work without `/etc/hosts` editing.

### Custom DNS Domain

```bash
container system property set dns.domain myapp.internal
# Now containers resolve as <name>.myapp.internal
```

### DNS with VPNs

This is where most people hit trouble. Corporate VPNs often:
1. Override system DNS settings
2. Route all traffic through the VPN tunnel
3. Block `.internal` or `.local` domains

**Fix 1: Split DNS**

Tell the VPN client to exclude `.dev.internal` from the tunnel. In most VPN clients (WireGuard, OpenVPN, Cisco AnyConnect), this is "Split DNS" or "Domain bypass" — add `.dev.internal` to the exclusion list.

**Fix 2: Static DNS in the Container**

If the VPN doesn't support split DNS, hardcode the resolver in `/etc/resolv.conf` inside the container:

```bash
container exec myapp sh -c "echo 'nameserver 10.0.0.1' > /etc/resolv.conf"
```

`10.0.0.1` is the host's virtual network gateway — the Apple Container DNS resolver.

**Fix 3: Use IPs Directly**

Last resort. DNS is convenience, not requirement:

```bash
container inspect api | grep IP
# "ip": "10.0.0.5"

# Use 10.0.0.5:3000 directly in your app config
```

IPs are stable for the lifetime of the container. They change on recreate. For scripts, DNS is better; for debugging, IPs are fine.

## Private Registry

Pulling from Docker Hub is slow (internet round-trip per layer) and means your containers depend on an external service. A local registry cache fixes both.

### Run a Registry Mirror

```bash
container volume create registry-data

container run --name registry \
  --mount type=volume,src=registry-data,dst=/var/lib/registry \
  --memory-limit 256M \
  registry:2

# Access at registry.dev.internal:5000
```

### Configure Apple Container to Use the Mirror

```bash
container system property set registry.mirror http://registry.dev.internal:5000
```

Now `container pull nginx:alpine` checks the local mirror first. Cache hit = instant pull. Cache miss = pull from Docker Hub, cache it, then serve.

### Push Local Images

Build an image, tag it, push to your local registry:

```bash
# Build with Docker (or container build)
docker build -t myapp:v1.2 .

# Tag for local registry
docker tag myapp:v1.2 registry.dev.internal:5000/myapp:v1.2

# Push
docker push registry.dev.internal:5000/myapp:v1.2

# Pull from Apple Container
container pull registry.dev.internal:5000/myapp:v1.2
```

### Registry with TLS

For a registry accessible beyond localhost, add TLS (using the same nginx TLS pattern from Chapter 6):

```nginx
server {
  listen 443 ssl;
  server_name registry.mydomain.com;

  ssl_certificate     /etc/letsencrypt/live/registry.mydomain.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/registry.mydomain.com/privkey.pem;

  location / {
    proxy_pass http://registry.dev.internal:5000;
    client_max_body_size 0;  # no limit on image layer size
    proxy_request_buffering off;
  }
}
```

## Secrets Management

Docker Swarm has `secrets:`. Docker Compose has `.env` files. Apple Container has neither built-in — but the macOS ecosystem provides better alternatives.

### Option 1: 1Password CLI (Recommended)

The cleanest option. Secrets live in 1Password, injected at container start:

```bash
#!/bin/bash
# start-with-secrets.sh
set -euo pipefail

# Fetch secrets from 1Password, inject as env vars
export DATABASE_URL=$(op read "op://Dev/PostgreSQL/connection-string")
export REDIS_PASSWORD=$(op read "op://Dev/Redis/password")
export STRIPE_KEY=$(op read "op://Production/Stripe/secret-key")

container run --name api --machine my-stack \
  --env "DATABASE_URL=$DATABASE_URL" \
  --env "REDIS_PASSWORD=$REDIS_PASSWORD" \
  --env "STRIPE_KEY=$STRIPE_KEY" \
  myapp:latest
```

Secrets never touch disk. They exist in memory only during `op read`, then are passed directly to `container run`.

**Setup:**
```bash
brew install 1password-cli
op account add   # one-time setup
eval $(op signin)  # unlock vault (times out after 30 min)
```

### Option 2: macOS Keychain

Built-in, no install needed:

```bash
# Store
security add-generic-password -a "$USER" -s "myapp/db-password" -w "s3cret"

# Retrieve
DB_PASSWORD=$(security find-generic-password -a "$USER" -s "myapp/db-password" -w)

container run --name db \
  --env "POSTGRES_PASSWORD=$DB_PASSWORD" \
  postgres:16-alpine
```

### Option 3: SOPS + Age (Git-Friendly)

For teams that want encrypted secrets in version control:

```bash
# Install
brew install sops age

# Generate age key
age-keygen -o ~/.config/sops/age/keys.txt

# Create encrypted secrets file
sops --encrypt secrets.yaml > secrets.enc.yaml

# Decrypt at deploy time
eval $(sops --decrypt secrets.enc.yaml | grep -v '^#' | sed 's/: /=/g')
container run --name api --env-file <(sops --decrypt secrets.enc.yaml | sed 's/: /=/g') myapp:latest
```

### Anti-Pattern: `.env` on Disk

```bash
# DON'T do this
echo 'DB_PASSWORD=s3cret' > .env
container run --env-file .env myapp:latest
```

`.env` files sitting on disk are the #1 cause of leaked credentials in internal repos. If you must use `.env`, put it outside the project directory and `chmod 600` it. Better: use 1Password CLI.

## Container-to-Host File Access

By default, containers cannot access the host filesystem. You grant access explicitly with `--mount type=bind`. No mount = no access. This is a stronger default than Docker, where `/var/run/docker.sock` access is a common privilege escalation vector.

**There is no Apple Container equivalent of `/var/run/docker.sock`.** Containers cannot issue `container run` commands to the host.

## Quick Security Checklist

- [ ] `.env` files are gitignored (better: not on disk at all)
- [ ] Database passwords come from 1Password/Keychain, not hardcoded in scripts
- [ ] TLS enabled on any container reachable beyond localhost
- [ ] Untrusted containers run on isolated machine groups
- [ ] `--network host-only` used for offline-only services
- [ ] Private registry mirror configured (eliminates Docker Hub dependency for pulls)
- [ ] No bind mount exposes `~/.ssh`, `~/.aws`, or other credential directories

---

**Next: Chapter 8 — Troubleshooting & Tuning.** Common errors, I/O benchmarks, memory sizing, and the upgrade path.
