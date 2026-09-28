<script lang="ts">
  import { store } from '$lib/store.svelte.ts';
</script>

<aside class="sidebar">
  <div class="sidebar-header">
    <span class="sidebar-title">Gumcord</span>
    <button class="btn-icon" title="Log out" onclick={() => store.logout()}>↩</button>
  </div>

  <div class="section-label">Text</div>
  {#each store.channels.filter(c => c.kind === 'text') as ch (ch.id)}
    <button
      class="channel-btn"
      class:active={store.activeChannel?.id === ch.id}
      onclick={() => store.selectChannel(ch)}
    ># {ch.name}</button>
  {/each}

  <div class="section-label voice-label">Voice</div>
  {#each store.channels.filter(c => c.kind === 'voice') as ch (ch.id)}
    <div class="voice-row">
      <button
        class="channel-btn voice-channel"
        class:in-voice={!!store.room}
        onclick={() => store.room ? store.leaveVoice() : store.joinVoice(ch)}
      >
        🔊 {ch.name}
        {#if store.room}<span class="leave-hint">leave</span>{/if}
      </button>

      {#if store.room && store.voiceParticipants.length > 0}
        <div class="voice-members">
          {#each store.voiceParticipants as p (p.identity)}
            <span class="voice-member" class:speaking={p.speaking}>
              <span class="voice-dot"></span>{p.identity}
            </span>
          {/each}
        </div>
      {/if}
    </div>
  {/each}

  <div class="sidebar-footer">
    <span class="self-name">{store.username}</span>
    {#if store.room}
      <button
        class="btn-mute"
        class:muted={store.voiceMuted}
        title={store.voiceMuted ? 'Unmute' : 'Mute'}
        onclick={() => store.toggleMute()}
      >{store.voiceMuted ? '🔇' : '🎙'}</button>
    {/if}
  </div>
</aside>

<style>
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

  .voice-label { margin-top: 4px; }

  .channel-btn {
    display: flex;
    align-items: center;
    width: calc(100% - 12px);
    text-align: left;
    padding: 5px 12px;
    border: none;
    background: none;
    color: #6b7290;
    font-size: 14px;
    cursor: pointer;
    border-radius: 4px;
    margin: 1px 6px;
    transition: background .1s, color .1s;
  }

  .channel-btn:hover  { background: #2a2d4a; color: #d4d8f0; }
  .channel-btn.active { background: #2e3154; color: #e8eaf6; }

  .voice-row { display: flex; flex-direction: column; }

  .voice-channel { gap: 6px; }
  .voice-channel.in-voice { color: #7c5cbf; }
  .leave-hint { margin-left: auto; font-size: 11px; color: #e57373; }

  .voice-members {
    padding: 2px 12px 4px 28px;
    display: flex;
    flex-direction: column;
    gap: 3px;
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
</style>
