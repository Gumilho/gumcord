<script>
  import { Room, RoomEvent, Track } from 'livekit-client';
  import { LIVEKIT_HOST, LIVEKIT_WS } from '$lib/config.js';

  let token = $state('');
  let status = $state('disconnected');
  let muted = $state(false);

  /** @type {Room | null} */
  let room = null;

  async function join() {
    if (!token.trim()) return;
    status = 'connecting…';

    room = new Room({
      rtcConfig: {
        iceServers: [{
          urls: `turn:${LIVEKIT_HOST}:3478?transport=tcp`,
          username: 'livekit',
          credential: 'turnpass',
        }],
      },
    });

    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) {
        const el = track.attach();
        document.body.appendChild(el);
      }
    });

    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach();
    });

    room.on(RoomEvent.Disconnected, () => {
      status = 'disconnected';
      room = null;
    });

    await room.connect(LIVEKIT_WS, token.trim());
    await room.localParticipant.setMicrophoneEnabled(true);
    status = 'connected';
  }

  async function toggleMute() {
    if (!room) return;
    muted = !muted;
    await room.localParticipant.setMicrophoneEnabled(!muted);
  }

  async function leave() {
    if (!room) return;
    await room.disconnect();
    status = 'disconnected';
    room = null;
  }
</script>

<main>
  <h1>Gumcord — voice test</h1>

  {#if status === 'disconnected'}
    <div class="join-form">
      <input
        type="text"
        placeholder="Paste your lk token here"
        bind:value={token}
        onkeydown={(e) => e.key === 'Enter' && join()}
      />
      <button onclick={join} disabled={!token.trim()}>Join voice</button>
    </div>
  {:else if status === 'connecting…'}
    <p>Connecting…</p>
  {:else}
    <p class="status-connected">Connected</p>
    <div class="controls">
      <button onclick={toggleMute}>{muted ? 'Unmute' : 'Mute'}</button>
      <button class="leave" onclick={leave}>Leave</button>
    </div>
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: Inter, Avenir, Helvetica, Arial, sans-serif;
    background: #1a1a2e;
    color: #e0e0f0;
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
  }

  main {
    text-align: center;
    padding: 2rem;
  }

  h1 {
    font-size: 1.8rem;
    margin-bottom: 2rem;
    color: #a78bfa;
  }

  .join-form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    align-items: center;
  }

  input {
    width: 360px;
    padding: 0.6em 1em;
    border-radius: 8px;
    border: 1px solid #4a4a6a;
    background: #2a2a4a;
    color: #e0e0f0;
    font-size: 0.9rem;
  }

  button {
    padding: 0.6em 1.6em;
    border-radius: 8px;
    border: none;
    background: #7c3aed;
    color: #fff;
    font-size: 1rem;
    cursor: pointer;
    transition: background 0.2s;
  }

  button:hover:not(:disabled) {
    background: #6d28d9;
  }

  button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  button.leave {
    background: #b91c1c;
  }

  button.leave:hover {
    background: #991b1b;
  }

  .controls {
    display: flex;
    gap: 1rem;
    justify-content: center;
    margin-top: 1rem;
  }

  .status-connected {
    color: #34d399;
    font-weight: 600;
    margin-bottom: 0.5rem;
  }
</style>
