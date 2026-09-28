<script lang="ts">
  import { store } from "$lib/store.svelte.ts";
  import { tooltip } from "$lib/tooltip.ts";
  import Icon from "$lib/components/Icon.svelte";
  import UserAvatar from "$lib/components/UserAvatar.svelte";

  // Which voice channel each online user is in, by identity (user ID).
  const voiceChannelOf = $derived.by(() => {
    const names = new Map(store.channels.map((c) => [c.id, c.name]));
    const where = new Map<string, string>();
    for (const [id, members] of store.voiceRooms) {
      for (const m of members) where.set(m.identity, names.get(id) ?? "voice");
    }
    // Your own call is known right away; the server's list lags your joins and leaves.
    if (store.me) {
      const me = String(store.me.id);
      if (store.voiceChannel) where.set(me, store.voiceChannel.name);
      else where.delete(me);
    }
    return where;
  });
</script>

<aside class="members" aria-label="Online members">
  <h2 class="heading">Online — {store.online.length}</h2>
  <ul>
    {#each store.online as u (u.id)}
      {@const inVoice = voiceChannelOf.get(String(u.id))}
      <li class="member">
        <div class="avatar">
          <UserAvatar name={u.name} src={u.avatar} />
          <span class="online-dot" aria-hidden="true"></span>
        </div>
        <span class="name">{u.name}</span>
        {#if inVoice}
          <span class="in-voice" role="img" aria-label="In {inVoice}" use:tooltip={`In ${inVoice}`}>
            <Icon name="speaker" size={16} />
          </span>
        {/if}
      </li>
    {/each}
  </ul>
</aside>

<style>
  .members {
    width: 240px;
    flex-shrink: 0;
    overflow-y: auto;
    padding: 8px 8px 16px;
    border-left: 1px solid #252840;
    background: #1e2035;
  }

  .heading {
    margin: 0;
    padding: 16px 8px 6px;
    color: #6b7290;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .member {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 8px;
    border-radius: 4px;
  }

  .avatar {
    position: relative;
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: #5b40c2;
    color: #fff;
    font-size: 14px;
    font-weight: 700;
    user-select: none;
  }

  /* The ring matches the list background, cutting the dot out of the avatar. */
  .online-dot {
    position: absolute;
    right: -2px;
    bottom: -2px;
    width: 12px;
    height: 12px;
    border: 2.5px solid #1e2035;
    border-radius: 50%;
    background: #4ade80;
  }

  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: #c8cce8;
    font-size: 14px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .in-voice {
    display: flex;
    color: #4ade80;
  }
</style>
