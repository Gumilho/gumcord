# Gumcord

A small, self-hosted Discord-style app for a group of friends: text channels, voice calls and screen sharing, in the browser or as a lightweight desktop app.

## Features

- **Text channels:** live messages, with image and file uploads up to 25 MB.
- **Voice channels:**
  - self-hosted [LiveKit](https://livekit.io) media server;
  - mute and deafen;
  - speaking indicators and connection quality;
  - a call view with everyone's tiles.
- **Screen sharing:** viewers opt in to each stream, and system audio is included where the browser supports it.
- **Sign-in with [PocketID](https://pocket-id.org):**
  - display names and profile pictures come from PocketID;
  - access is limited to a PocketID group;
  - no passwords stored in Gumcord.
- **Desktop app:** built with [Tauri](https://tauri.app).
  - It uses the system's own webview, so it's a few MB instead of a bundled browser.
  - It loads your server, so updates reach it without a reinstall.
- **One container:** the Go backend serves the app and the API from a single origin, with SQLite for storage.

## How it fits together

| Part | Stack | Where |
|---|---|---|
| Web app | SvelteKit (Svelte 5), single-page app | `src/` |
| Backend | Go, SQLite | `backend/` |
| Voice and screen sharing | LiveKit server | `livekit.example.yaml` |
| Sign-in | PocketID over OpenID Connect; other OIDC providers should work | `backend/auth.go` |
| Desktop app | Tauri 2 | `src-tauri/` |

## Running it

- **Self-hosting:** see [DEPLOY.md](DEPLOY.md). It covers PocketID, Docker Compose, LiveKit and exposing everything through a reverse proxy.
- **Development:** needs Node 22, Go 1.27 and Docker (for LiveKit). With `DEV_LOGIN=1` you can sign in with any name, no PocketID needed. Full steps are in the [development section of DEPLOY.md](DEPLOY.md#development).

## Desktop app

Download an installer from the Releases page, or build one with `npm run tauri build`. You'll need Rust 1.90+ and [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/). Set `build.frontendDist` in `src-tauri/tauri.conf.json` to your server's address first.

## License

[MIT](LICENSE). The sound effects in `assets/` were made for this project and are covered by the same license.
