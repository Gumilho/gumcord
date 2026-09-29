<script lang="ts">
  import { onlyEmotes, parseMessage, previewLinks } from "$lib/richtext.ts";
  import { getEmbed } from "$lib/embeds.ts";
  import { store } from "$lib/store.svelte.ts";
  import { t } from "$lib/i18n.svelte.ts";

  // A message's text with its links clickable and emotes shown, and link previews underneath.
  let { content, edited = "", onresize, onview }: {
    content: string;
    edited?: string; // when it was last edited, if it was
    onresize: () => void; // a preview appeared or its picture loaded: the chat grew
    onview: (src: string) => void; // open a picture in the viewer
  } = $props();

  const pieces = $derived(parseMessage(content, store.emoteMap));
  const previews = $derived(previewLinks(pieces));
  // Players only load once pressed: nothing reaches the video's site before that.
  let playing = $state(new Set<string>());
</script>

{#if content}
  <!-- On one line: the text keeps its own spacing (pre-wrap). -->
  <p class="msg-content" class:jumbo={onlyEmotes(pieces)}>{#each pieces as p, i (i)}{#if p.kind === "text"}{p.text}{:else if p.kind === "emote"}<img class="emote" src={p.emote.url} alt=":{p.emote.name}:" title=":{p.emote.name}:" />{:else}<a href={p.url} target="_blank" rel="noreferrer noopener">{p.url}</a>{/if}{/each}{#if edited}<span class="edited" title={t("Edited {time}", { time: edited })}>{" "}{t("(edited)")}</span>{/if}</p>
{/if}

{#each previews as url (url)}
  {#await getEmbed(url) then e}
    {#if e?.kind === "image" && e.image}
      <button class="embed-picture" type="button" aria-label={t("View image")} onclick={() => onview(e.image!)}>
        <img src={e.image} alt="" loading="lazy" onload={onresize} {@attach onresize} />
      </button>
    {:else if e?.kind === "video" && e.video}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video class="embed-video-file" src={e.video} controls preload="none" {@attach onresize}></video>
    {:else if e}
      <div class="embed" class:large={e.large} style:--accent={e.color} {@attach onresize}>
        <div class="embed-text">
          {#if e.site}<span class="embed-site">{e.site}</span>{/if}
          {#if e.title}<a class="embed-title" href={e.url} target="_blank" rel="noreferrer noopener">{e.title}</a>{/if}
          {#if e.description}<p class="embed-description">{e.description}</p>{/if}
        </div>
        {#if e.player && playing.has(url)}
          <iframe
            class="embed-player"
            src={e.player}
            title={e.title ?? t("Video")}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowfullscreen
            referrerpolicy="strict-origin-when-cross-origin"
          ></iframe>
        {:else if e.video && playing.has(url)}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video class="embed-player" src={e.video} controls autoplay playsinline loop={e.loop} muted={e.loop}></video>
        {:else if (e.player || e.video) && e.image}
          <button class="embed-image play" type="button" aria-label={t("Play {title}", { title: e.title ?? t("Video") })} onclick={() => (playing = new Set(playing).add(url))}>
            <img src={e.image} alt="" loading="lazy" onload={onresize} />
            <span class="play-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11.04-6.86a1 1 0 0 0 0-1.72L9.5 4.28A1 1 0 0 0 8 5.14Z" /></svg></span>
          </button>
        {:else if e.image}
          <a class="embed-image" href={e.url} target="_blank" rel="noreferrer noopener" tabindex="-1">
            <img src={e.image} alt="" loading="lazy" onload={onresize} />
          </a>
        {/if}
      </div>
    {/if}
  {/await}
{/each}

<style>
  .msg-content {
    margin: 0;
    color: #c8cce8;
    line-height: 1.5;
    word-break: break-word;
    white-space: pre-wrap;
  }

  .edited {
    color: #5c6283;
    font-size: 11px;
  }

  .emote {
    width: 22px;
    height: 22px;
    margin: -2px 1px 0;
    object-fit: contain;
    vertical-align: middle;
  }

  .jumbo .emote {
    width: 48px;
    height: 48px;
    margin: 2px 2px 0 0;
  }

  .msg-content a {
    color: #a78bfa;
    text-decoration: none;
  }

  .msg-content a:hover { text-decoration: underline; }

  .embed {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 12px;
    align-self: flex-start;
    max-width: min(432px, 100%);
    margin-top: 4px;
    padding: 10px 14px 12px 12px;
    border-left: 4px solid var(--accent, #3b3f66);
    border-radius: 4px;
    background: #1c1e33;
  }

  .embed.large { grid-template-columns: minmax(0, 1fr); }

  .embed-text {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .embed-site {
    color: #8a90b4;
    font-size: 11px;
  }

  .embed-title {
    color: #a78bfa;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.3;
    text-decoration: none;
  }

  .embed-title:hover { text-decoration: underline; }

  .embed-description {
    display: -webkit-box;
    margin: 0;
    overflow: hidden;
    color: #b4b9d6;
    font-size: 12px;
    line-height: 1.45;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 4;
    line-clamp: 4;
  }

  .embed-image img {
    display: block;
    width: 80px;
    height: 80px;
    border-radius: 4px;
    object-fit: cover;
    background: #23253a;
  }

  .embed.large .embed-image img {
    width: 100%;
    height: auto;
    max-height: 300px;
    object-fit: contain;
  }

  .embed-player, .embed-video-file {
    display: block;
    width: 100%;
    max-width: min(400px, 100%);
    aspect-ratio: 16 / 9;
    border: none;
    border-radius: 4px;
    background: #000;
  }

  /* Videos we play ourselves keep their own shape: X has portrait and square ones too. */
  video.embed-player {
    aspect-ratio: auto;
    max-height: 360px;
  }

  .embed-video-file {
    margin-top: 4px;
    max-height: 300px;
  }

  .embed-image.play {
    position: relative;
    display: block;
    padding: 0;
    border: none;
    background: none;
    cursor: pointer;
  }

  .play-icon {
    position: absolute;
    top: 50%;
    left: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 56px;
    height: 56px;
    padding-left: 4px;
    border-radius: 50%;
    background: #000a;
    color: #fff;
    transform: translate(-50%, -50%);
    transition: background 0.15s;
  }

  .embed-image.play:hover .play-icon { background: #5b40c2; }

  .embed-picture {
    align-self: flex-start;
    padding: 0;
    border: none;
    background: none;
    cursor: zoom-in;
  }

  .embed-picture img {
    display: block;
    max-width: min(400px, 100%);
    max-height: 300px;
    margin-top: 4px;
    border-radius: 8px;
    object-fit: contain;
    background: #23253a;
  }
</style>
