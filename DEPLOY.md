# Deploying Gumcord

Everything is served from one domain, `https://gumcord.proxy.gumilho.com`. The Go backend serves the web app and the API. LiveKit handles voice. Sign-in goes through PocketID. The desktop app is a window onto that same site.

## 1. PocketID

Add an OIDC client (PocketID → OIDC Clients → Add):

- **Name:** Gumcord
- **Callback URL:** `https://gumcord.proxy.gumilho.com/api/auth/callback`. For development, also add `http://localhost:1420/api/auth/callback`.
- **Logout callback URLs:** leave empty. Gumcord's log out only clears its own session.
- **Public client:** off. The backend keeps the client secret.
- **PKCE:** on. Gumcord always sends a challenge.
- **Requires re-authentication:** off, unless you want a passkey prompt on every Gumcord sign-in.
- **Allowed user groups:** create a group for the people who may use Gumcord and pick it here. Everyone else is turned away at sign-in.

Copy the client ID and secret for step 2. Gumcord shows each person's PocketID **display name**.

## 2. Server

```sh
cp .env.example .env                 # fill in PUBLIC_URL, OIDC_*, LK_API_KEY, LK_API_SECRET
cp livekit.example.yaml livekit.yaml # node_ip + the same key/secret as .env
mkdir -p data
docker compose up -d --build
```

- **`interfaces: includes: [wt0]` in livekit.yaml** limits LiveKit to the NetBird interface, where proxied media arrives. Without it, joins fail with "could not establish pc connection" even though the packets reach the machine.
- **`node_ip` in livekit.yaml** must be the **public IPv4 of the server running NetBird's reverse proxy**, where the UDP/TCP services listen. This is where clients send voice. Never use a Cloudflare IP: Cloudflare only forwards web traffic. To find it, run `curl -4 ifconfig.me` on that server.
- **The LiveKit secret** should be long and random: `openssl rand -base64 32`.

## 3. NetBird services

| Service | Type | Target | Settings |
|---|---|---|---|
| `gumcord.proxy.gumilho.com` | HTTPS | server `8089` (the host port in docker-compose.yml) | No NetBird auth: Gumcord signs people in itself |
| same service, path `/rtc` | (second path) | server `7880` | **Preserve Full Path** on |
| `gumcord-udp.proxy.gumilho.com`, port `7882` | UDP | server `7882` | Same public port as target |
| `gumcord-tcp.proxy.gumilho.com`, port `7881` | TCP | server `7881` | Same public port as target. Fallback for networks that block UDP |

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

`gumcord.proxy.gumilho.com` is covered by the proxy's own DNS (`*.proxy.gumilho.com`), so it needs no Cloudflare record. A name outside it would need a **DNS only** (grey cloud) CNAME, since NetBird has to get its own certificate for it.

## 4. Check

Open the site, sign in and join a voice channel.

- If joining hangs, or connects but nobody hears anything, the cause is `node_ip` or the UDP/TCP services.
- If signing in fails, check the callback URL and the allowed groups in PocketID.

## Backups and updates

- **Back up `data/`.** It holds the database, uploads, and `session.key`, which signs sessions; losing it signs everyone out. For a consistent copy while the app runs: `sqlite3 data/gumcord.db ".backup gumcord-backup.db"`.
- **Update:** `git pull && docker compose up -d --build`. Browsers and desktop apps pick up the new version on their next reload.

## Desktop app

The app loads `https://gumcord.proxy.gumilho.com` (`build.frontendDist` in `src-tauri/tauri.conf.json`), so server updates reach it without a reinstall. Sign-in opens the system browser, where passkeys work, and the app shows a code to match.

- **Build requirements:** Rust **1.90+** and [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/). On Linux that includes `webkit2gtk-4.1`.
- **Building:** run `npm run tauri build` on each OS you ship for. The installers land in `src-tauri/target/release/bundle/`.
- **Unsigned builds:** Windows SmartScreen and macOS Gatekeeper warn on first launch.

## Development

```sh
docker compose up -d livekit              # livekit.yaml node_ip = your LAN IP
cd backend && set -a && . ./.env && set +a && go run .
npm run dev                               # or: npm run tauri dev
```

- **`backend/.env`** needs `LK_API_KEY` and `LK_API_SECRET`, plus `DEV_LOGIN=1` to sign in with any name.
- **Vite** proxies `/api`, `/files` and `/rtc`, so development uses the same URLs as production.
- **Real PocketID sign-in in development:** set `PUBLIC_URL=http://localhost:1420` and `OIDC_*` instead of `DEV_LOGIN`.
