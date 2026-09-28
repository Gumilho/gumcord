<script>
  import { onDestroy } from 'svelte';
  import { Room, RoomEvent, Track } from 'livekit-client';
  import { API_BASE, LIVEKIT_WS } from '$lib/config.js';

  // --- auth state ---
  let token = $state(localStorage.getItem('gc_token') ?? '');
  let username = $state(localStorage.getItem('gc_username') ?? '');
  let loginError = $state('');
  let loginUsername = $state('');
  let loginPassword = $state('');

  // --- channels ---
  let channels = $state([]);
  let activeChannel = $state(null);

  // --- messages ---
  let messages = $state([]);
  let draft = $state('');
  let msgEnd = $state(null); // scroll anchor

  // --- websocket ---
  let ws = $state(null);

  // --- voice ---
  let room = $state(null);
  let voiceMuted = $state(false);
  let voiceParticipants = $state([]); // [{identity, speaking}]
  const audioEls = new Map(); // trackSid → HTMLAudioElement

  // -------------------------------------------------------
  // Auth
  // -------------------------------------------------------
  async function login() {
    loginError = '';
    const res = await fetch(`${API_BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: loginUsername, password: loginPassword }),
    });
    if (!res.ok) { loginError = 'Wrong password or server error.'; return; }
    const data = await res.json();
    token = data.token;
    username = loginUsername;
    localStorage.setItem('gc_token', token);
    localStorage.setItem('gc_username', username);
    await boot();
  }

  function logout() {
    leaveVoice();
    ws?.close();
    ws = null;
    token = '';
    username = '';
    channels = [];
    messages = [];
    activeChannel = null;
    localStorage.removeItem('gc_token');
    localStorage.removeItem('gc_username');
  }

  // -------------------------------------------------------
  // Boot (after login or on page load with saved token)
  // -------------------------------------------------------
  async function boot() {
    const res = await fetch(`${API_BASE}/channels`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) { logout(); return; }
    channels = await res.json();
    const first = channels.find(c => c.kind === 'text');
    if (first) selectChannel(first);
    openWS();
  }

  // -------------------------------------------------------
  // Channels / messages
  // -------------------------------------------------------
  async function selectChannel(ch) {
    if (ch.kind === 'voice') return; // voice is joined via button, not selected
    activeChannel = ch;
    const res = await fetch(`${API_BASE}/channels/${ch.id}/messages`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    messages = res.ok ? await res.json() : [];
    scrollToBottom();
  }

  function scrollToBottom() {
    // Let the DOM paint first
    setTimeout(() => msgEnd?.scrollIntoView({ block: 'end' }), 0);
  }

  // -------------------------------------------------------
  // WebSocket
  // -------------------------------------------------------
  function openWS() {
    if (ws) return;
    const url = `${API_BASE.replace('http', 'ws')}/ws?token=${token}`;
    ws = new WebSocket(url);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (activeChannel && msg.channel_id === activeChannel.id) {
        messages = [...messages, msg];
        scrollToBottom();
      }
    };
    ws.onclose = () => { ws = null; };
  }

  function sendMessage() {
    const content = draft.trim();
    if (!content || !activeChannel || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ channel_id: activeChannel.id, content }));
    draft = '';
  }

  // -------------------------------------------------------
  // Voice
  // -------------------------------------------------------
  async function joinVoice(ch) {
    if (room) return;
    const res = await fetch(`${API_BASE}/voice/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: ch.name }),
    });
    if (!res.ok) return;
    const { token: lkToken } = await res.json();

    room = new Room({
      rtcConfig: {
        iceServers: [{
          urls: `turn:${new URL(API_BASE).hostname}:3478?transport=tcp`,
          username: 'livekit',
          credential: 'turnpass',
        }],
      },
    });

    room.on(RoomEvent.ParticipantConnected,    updateParticipants);
    room.on(RoomEvent.ParticipantDisconnected, updateParticipants);

    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) {
        const el = track.attach();
        audioEls.set(track.sid, el);
        document.body.appendChild(el);
      }
      updateParticipants();
    });

    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) {
        track.detach();
        audioEls.get(track.sid)?.remove();
        audioEls.delete(track.sid);
      }
      updateParticipants();
    });

    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      const speaking = new Set(speakers.map(p => p.identity));
      voiceParticipants = voiceParticipants.map(p => ({ ...p, speaking: speaking.has(p.identity) }));
    });

    room.on(RoomEvent.Disconnected, () => {
      audioEls.forEach((el, sid) => el.remove());
      audioEls.clear();
      room = null;
      voiceParticipants = [];
    });

    await room.connect(LIVEKIT_WS, lkToken);
    await room.localParticipant.setMicrophoneEnabled(true);
    updateParticipants();
  }

  async function leaveVoice() {
    if (!room) return;
    // Detach all remote audio before disconnecting
    audioEls.forEach((el) => el.remove());
    audioEls.clear();
    await room.disconnect();
    room = null;
    voiceMuted = false;
    voiceParticipants = [];
  }

  async function toggleMute() {
    if (!room) return;
    voiceMuted = !voiceMuted;
    await room.localParticipant.setMicrophoneEnabled(!voiceMuted);
  }

  function updateParticipants() {
    if (!room) return;
    const current = new Map(voiceParticipants.map(p => [p.identity, p.speaking]));
    voiceParticipants = [
      room.localParticipant,
      ...Array.from(room.remoteParticipants.values()),
    ].map(p => ({ identity: p.identity, speaking: current.get(p.identity) ?? false }));
  }

  // -------------------------------------------------------
  // Init — restore session from localStorage
  // -------------------------------------------------------
  if (token) boot();

  onDestroy(() => {
    ws?.close();
    audioEls.forEach(el => el.remove());
    audioEls.clear();
    room?.disconnect();
  });
</script>

{#if !token}
<!-- ── Login ── -->
<div class="login-wrap">
  <div class="login-box">
    <div class="login-logo">GC</div>
    <h1>Gumcord</h1>
    <p class="login-sub">Enter a name and the server password.</p>
    <form onsubmit={(e) => { e.preventDefault(); login(); }}>
      <input
        class="field"
        type="text"
        placeholder="Username"
        bind:value={loginUsername}
        autocomplete="username"
        required
      />
      <input
        class="field"
        type="password"
        placeholder="Password"
        bind:value={loginPassword}
        autocomplete="current-password"
        required
      />
      {#if loginError}<p class="login-error">{loginError}</p>{/if}
      <button class="btn-primary" type="submit">Join</button>
    </form>
  </div>
</div>

{:else}
<!-- ── App ── -->
<div class="app">

  <!-- Sidebar -->
  <aside class="sidebar">
    <div class="sidebar-header">
      <span class="sidebar-title">Gumcord</span>
      <button class="btn-icon" title="Log out" onclick={logout}>↩</button>
    </div>

    <div class="section-label">Text</div>
    {#each channels.filter(c => c.kind === 'text') as ch (ch.id)}
      <button
        class="channel-btn"
        class:active={activeChannel?.id === ch.id}
        onclick={() => selectChannel(ch)}
      ># {ch.name}</button>
    {/each}

    <div class="section-label" style="margin-top:12px">Voice</div>
    {#each channels.filter(c => c.kind === 'voice') as ch (ch.id)}
      <div class="voice-row">
        <button
          class="channel-btn voice-channel"
          onclick={() => room ? leaveVoice() : joinVoice(ch)}
          class:in-voice={!!room}
        >
          🔊 {ch.name}
          {#if room}<span class="leave-hint">leave</span>{/if}
        </button>
        {#if room && voiceParticipants.length > 0}
          <div class="voice-members">
            {#each voiceParticipants as p (p.identity)}
              <span class="voice-member" class:speaking={p.speaking}>
                <span class="voice-dot"></span>{p.identity}
              </span>
            {/each}
          </div>
        {/if}
      </div>
    {/each}

    <div class="sidebar-footer">
      <span class="self-name">{username}</span>
      {#if room}
        <button
          class="btn-mute"
          class:muted={voiceMuted}
          onclick={toggleMute}
          title={voiceMuted ? 'Unmute' : 'Mute'}
        >{voiceMuted ? '🔇' : '🎙'}</button>
      {/if}
    </div>
  </aside>

  <!-- Main -->
  <main class="main">
    {#if activeChannel}
      <header class="main-header"># {activeChannel.name}</header>

      <div class="messages">
        {#each messages as msg (msg.id)}
          <div class="message">
            <span class="msg-author">{msg.username}</span>
            <span class="msg-time">{new Date(msg.created_at + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            <p class="msg-content">{msg.content}</p>
          </div>
        {/each}
        <div bind:this={msgEnd}></div>
      </div>

      <form class="input-bar" onsubmit={(e) => { e.preventDefault(); sendMessage(); }}>
        <input
          class="msg-input"
          type="text"
          placeholder="Message #{activeChannel.name}"
          bind:value={draft}
        />
        <button class="btn-send" type="submit">Send</button>
      </form>
    {:else}
      <div class="empty-state">Select a channel</div>
    {/if}
  </main>

</div>
{/if}

<style>
  :global(*, *::before, *::after) { box-sizing: border-box; }
  :global(html, body) {
    height: 100%;
    margin: 0;
    background: #1a1b2e;
    color: #d4d8f0;
    font-family: system-ui, sans-serif;
    font-size: 14px;
  }

  /* ── Login ── */
  .login-wrap {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: #1a1b2e;
  }

  .login-box {
    width: 100%;
    max-width: 340px;
    background: #23253a;
    border: 1px solid #33365a;
    border-radius: 12px;
    padding: 36px 28px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0;
  }

  .login-logo {
    width: 52px;
    height: 52px;
    border-radius: 14px;
    background: #5b40c2;
    color: #fff;
    font-weight: 700;
    font-size: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 14px;
  }

  .login-box h1 {
    margin: 0 0 6px;
    font-size: 22px;
    font-weight: 700;
    color: #e8eaf6;
  }

  .login-sub {
    margin: 0 0 24px;
    color: #6b7290;
    font-size: 13px;
    text-align: center;
  }

  .login-box form {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .field {
    width: 100%;
    padding: 9px 12px;
    border-radius: 7px;
    border: 1px solid #33365a;
    background: #1a1b2e;
    color: #d4d8f0;
    font-size: 14px;
    outline: none;
  }

  .field:focus { border-color: #7c5cbf; }

  .login-error {
    color: #e57373;
    font-size: 13px;
    margin: 0;
    text-align: center;
  }

  .btn-primary {
    padding: 9px 0;
    border-radius: 7px;
    border: none;
    background: #5b40c2;
    color: #fff;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: background .15s;
  }

  .btn-primary:hover { background: #6d50d6; }

  /* ── App shell ── */
  .app {
    height: 100vh;
    display: flex;
    overflow: hidden;
  }

  /* ── Sidebar ── */
  .sidebar {
    width: 220px;
    flex-shrink: 0;
    background: #1e2035;
    border-right: 1px solid #2a2d4a;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .sidebar-header {
    padding: 14px 12px 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid #2a2d4a;
  }

  .sidebar-title {
    font-weight: 700;
    font-size: 15px;
    color: #e8eaf6;
  }

  .btn-icon {
    background: none;
    border: none;
    color: #6b7290;
    cursor: pointer;
    font-size: 16px;
    padding: 2px 4px;
    border-radius: 4px;
  }

  .btn-icon:hover { color: #d4d8f0; background: #2a2d4a; }

  .section-label {
    padding: 14px 12px 4px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: .08em;
    text-transform: uppercase;
    color: #4a5168;
  }

  .channel-btn {
    display: block;
    width: 100%;
    text-align: left;
    padding: 5px 12px;
    border: none;
    background: none;
    color: #6b7290;
    font-size: 14px;
    cursor: pointer;
    border-radius: 4px;
    margin: 1px 6px;
    width: calc(100% - 12px);
    transition: background .1s, color .1s;
  }

  .channel-btn:hover { background: #2a2d4a; color: #d4d8f0; }
  .channel-btn.active { background: #2e3154; color: #e8eaf6; }

  .voice-row { display: flex; flex-direction: column; }

  .voice-channel { display: flex; align-items: center; gap: 6px; }
  .voice-channel.in-voice { color: #7c5cbf; }
  .leave-hint { margin-left: auto; font-size: 11px; color: #e57373; }

  .voice-members {
    padding: 2px 12px 4px 28px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .voice-member {
    font-size: 12px;
    color: #6b7290;
    display: flex;
    align-items: center;
    gap: 5px;
    transition: color .15s;
  }

  .voice-member.speaking { color: #4ade80; }

  .voice-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #4a5168;
    flex-shrink: 0;
    transition: background .15s;
  }

  .voice-member.speaking .voice-dot { background: #4ade80; }

  .sidebar-footer {
    margin-top: auto;
    padding: 10px 12px;
    border-top: 1px solid #2a2d4a;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .self-name {
    flex: 1;
    font-size: 13px;
    font-weight: 600;
    color: #d4d8f0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .btn-mute {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 18px;
    padding: 2px;
    border-radius: 4px;
    line-height: 1;
  }

  .btn-mute.muted { opacity: .5; }

  /* ── Main ── */
  .main {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: #1a1b2e;
  }

  .main-header {
    padding: 12px 16px;
    border-bottom: 1px solid #2a2d4a;
    font-weight: 600;
    font-size: 15px;
    color: #e8eaf6;
    flex-shrink: 0;
  }

  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .message { display: flex; flex-direction: column; gap: 2px; }

  .msg-author {
    font-weight: 600;
    font-size: 13.5px;
    color: #9d82e0;
  }

  .msg-time {
    font-size: 11px;
    color: #4a5168;
    margin-left: 6px;
  }

  .msg-content {
    margin: 0;
    color: #c8cce8;
    line-height: 1.5;
    word-break: break-word;
  }

  .input-bar {
    padding: 10px 16px;
    display: flex;
    gap: 8px;
    border-top: 1px solid #2a2d4a;
    flex-shrink: 0;
  }

  .msg-input {
    flex: 1;
    padding: 9px 12px;
    border-radius: 7px;
    border: 1px solid #33365a;
    background: #23253a;
    color: #d4d8f0;
    font-size: 14px;
    outline: none;
  }

  .msg-input:focus { border-color: #7c5cbf; }

  .btn-send {
    padding: 9px 16px;
    border-radius: 7px;
    border: none;
    background: #5b40c2;
    color: #fff;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }

  .btn-send:hover { background: #6d50d6; }

  .empty-state {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #4a5168;
    font-size: 15px;
  }
</style>
