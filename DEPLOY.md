# Deploying Gumcord

Everything is served from one domain. The Go backend serves the web app and the API. LiveKit handles voice. Sign-in goes through PocketID. The desktop app is a window onto that same site.

This guide uses `gumcord.example.com` for Gumcord and `auth.example.com` for PocketID; use your own domains. It exposes the server through [NetBird's reverse proxy](https://docs.netbird.io/manage/reverse-proxy). Any reverse proxy works if it can route `/rtc` to LiveKit and forward UDP 7882 and TCP 7881.

## 1. PocketID

Add an OIDC client (PocketID → OIDC Clients → Add):

- **Name:** Gumcord
- **Callback URL:** `https://gumcord.example.com/api/auth/callback`. For development, also add `http://localhost:1420/api/auth/callback`.
- **Logout callback URLs:** leave empty. Gumcord's log out only clears its own session.
- **Public client:** off. The backend keeps the client secret.
- **PKCE:** on. Gumcord always sends a challenge.
- **Requires re-authentication:** off, unless you want a passkey prompt on every Gumcord sign-in.
- **Allowed user groups:** create a group for the people who may use Gumcord and pick it here. Everyone else is turned away at sign-in.

Copy the client ID and secret for step 2. Gumcord shows each person's PocketID **display name**.

Also create a group named **`gumcord-admins`** (or whatever `ADMIN_GROUP` says) and put yourself in it. Its members are Gumcord admins: they create servers and channels and add people to servers. Everyone else only sees the servers an admin has added them to. Admin status is read at sign-in, so sign out and back in after changing the group.

## 2. Server

```sh
cp .env.example .env                 # fill in PUBLIC_URL, OIDC_*, LK_API_KEY, LK_API_SECRET
cp livekit.example.yaml livekit.yaml # node_ip + the same key/secret as .env
mkdir -p data
docker compose up -d --build
```

- **`interfaces: includes: [wt0]` in livekit.yaml** limits LiveKit to the NetBird interface, where proxied media arrives. Without it, joins fail with "could not establish pc connection" even though the packets reach the machine.
- **`node_ip` in livekit.yaml** must be the **public IPv4 of the server running NetBird's reverse proxy**, where the UDP/TCP services listen. This is where clients send voice. Never use a Cloudflare IP: Cloudflare only forwards web traffic. To find it, run `curl -4 ifconfig.me` on that server.
- **Your domain** goes in `PUBLIC_URL` in `.env`, and in `build.frontendDist` in `src-tauri/tauri.conf.json` for the desktop app.
- **The LiveKit secret** should be long and random: `openssl rand -base64 32`.

## 3. NetBird services

| Service | Type | Target | Settings |
|---|---|---|---|
| `gumcord.example.com` | HTTPS | server `8089` (the host port in docker-compose.yml) | No NetBird auth: Gumcord signs people in itself |
| same service, path `/rtc` | (second path) | server `7880` | **Preserve Full Path** on |
| `gumcord-udp.example.com`, port `7882` | UDP | server `7882` | Same public port as target |
| `gumcord-tcp.example.com`, port `7881` | TCP | server `7881` | Same public port as target. Fallback for networks that block UDP |

The public ports for 7881 and 7882 must equal LiveKit's, because LiveKit tells clients to use `node_ip:7881/7882`.

A self-hosted proxy only exposes 443 by default. On the NetBird server, publish the two media ports on the `proxy` service in NetBird's `docker-compose.yml`, then run `docker compose up -d proxy`:

```yaml
proxy:
  ports:
    - "7881:7881/tcp"
    - "7882:7882/udp"
```

Also allow 7881/tcp and 7882/udp in that server's firewall or cloud security group.

NetBird needs a domain on every service, and each domain can belong to only one service, so the UDP and TCP services need names of their own. Nothing connects to those names: TCP and UDP traffic is routed by port, and LiveKit hands clients the IP.

A name under the proxy's own wildcard domain needs no DNS record. Any other name needs a CNAME to the proxy. If you use Cloudflare, make it **DNS only** (grey cloud), since NetBird has to get its own certificate for it.

## 4. Check

Open the site, sign in and join a voice channel.

- If joining hangs, or connects but nobody hears anything, the cause is `node_ip` or the UDP/TCP services.
- If signing in fails, check the callback URL and the allowed groups in PocketID.

## 5. Hardening

Gumcord and LiveKit only need to be reached through NetBird. Out of the box, Docker and LiveKit listen on every interface, so devices on your LAN (and other NetBird peers) can reach them directly, skipping the proxy and its HTTPS.

- **Keep the secrets private:** `chmod 600 .env livekit.yaml`.
- **LiveKit's API only for NetBird, the Gumcord container and this machine.** In `livekit.yaml`:

  ```yaml
  bind_addresses:
    - 127.0.0.1
    - 172.17.0.1      # docker0, what host.docker.internal points the Gumcord container at
    - 100.x.y.z       # this machine's NetBird address: ip -4 addr show wt0
  room:
    max_participants: 25 # per call
  ```

  If NetBird isn't up yet when LiveKit starts, LiveKit exits, and Docker restarts it until it is.
- **Run LiveKit as your user, not root.** In `docker-compose.yml`, under `livekit:`, add `user: "1000:1000"` (your `id -u` and `id -g`, the owner of `livekit.yaml`). It only uses ports above 1024.
- **Gumcord only on the NetBird address:** change its port to `"100.x.y.z:8089:8080"`. Unlike LiveKit, Docker doesn't retry if that address doesn't exist yet at boot, so also make Docker start after NetBird: `sudo systemctl edit docker`, then add `[Unit]`, `After=netbird.service`, `Wants=netbird.service`. Alternatively, leave it and keep port 8089 closed in your router (it is unless you forwarded it).

## Backups and updates

- **Back up `data/`.** It holds the database, uploads, and `session.key`, which signs sessions; losing it signs everyone out. For a consistent copy while the app runs: `sqlite3 data/gumcord.db ".backup gumcord-backup.db"`.
- **Update:** `git pull && docker compose up -d --build`. Browsers and desktop apps pick up the new version on their next reload.

## Desktop app

The app loads the address in `build.frontendDist` in `src-tauri/tauri.conf.json`, so server updates reach it without a reinstall. Set it to your domain before building. Sign-in opens the system browser, where passkeys work, and the app shows a code to match.

- **Build requirements:** Rust **1.90+** and [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/). On Linux that includes `webkit2gtk-4.1`.
- **Building:** run `npm run tauri build` on each OS you ship for. The installers land in `src-tauri/target/release/bundle/`.
- **Unsigned builds:** Windows SmartScreen and macOS Gatekeeper warn on first launch.

### Releasing through GitHub

`.github/workflows/release.yml` builds the Linux and Windows installers and publishes them as a GitHub release:

1. Bump `"version"` in `src-tauri/tauri.conf.json` (for example to `0.2.0`) and commit.
2. Tag and push: `git tag v0.2.0 && git push origin main v0.2.0`. The tag must be `v` plus that version, or the workflow stops.
3. Wait about 10–15 minutes. The release stays a draft until both builds succeed, then publishes itself.

On a **private** repo, releases are only visible to people with access to the repo. Either add friends as collaborators with read access, or download the installers yourself and share them another way.

You only need a new release when the desktop shell changes. Changes to the web app reach the desktop app as soon as the server is updated.

## Development

```sh
docker compose up -d livekit              # LAN only: node_ip = your LAN IP, and drop the interfaces block
cd backend && set -a && . ./.env && set +a && go run .
npm run dev                               # or: npm run tauri dev
```

- **`backend/.env`** needs `LK_API_KEY` and `LK_API_SECRET`, plus `DEV_LOGIN=1` to sign in with any name.
- **Vite** proxies `/api`, `/files` and `/rtc`, so development uses the same URLs as production.
- **Real PocketID sign-in in development:** set `PUBLIC_URL=http://localhost:1420` and `OIDC_*` instead of `DEV_LOGIN`.
