import { browser } from '$app/environment';

// Automatically uses whatever host the app was opened from.
// Dev: open via LAN IP (e.g. http://192.168.0.205:1420) and it points there.
// Milestone 5: open via DuckDNS domain and it points there.
export const LIVEKIT_HOST = browser ? window.location.hostname : '';

export const LIVEKIT_WS = `ws://${LIVEKIT_HOST}:7880`;
export const API_BASE   = `http://${LIVEKIT_HOST}:8080`;
