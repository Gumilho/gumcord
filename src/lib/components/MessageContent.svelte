<script lang="ts">
  import { parseMessage, previewLinks } from "$lib/richtext.ts";
  import { getEmbed } from "$lib/embeds.ts";

  // A message's text with its links clickable, and previews of them underneath.
  let { content, onresize, onview }: {
    content: string;
    onresize: () => void; // a preview appeared or its picture loaded: the chat grew
    onview: (src: string) => void; // open a picture in the viewer
  } = $props();

  const pieces = $derived(parseMessage(content));
  const previews = $derived(previewLinks(pieces));
</script>

{#if content}
  <!-- On one line: the text keeps its own spacing (pre-wrap). -->
  <p class="msg-content">{#each pieces as p, i (i)}{#if p.kind === "text"}{p.text}{:else}<a href={p.url} target="_blank" rel="noreferrer noopener">{p.url}</a>{/if}{/each}</p>
{/if}

{#each previews as url (url)}
  {#await getEmbed(url) then e}
    {#if e?.kind === "image" && e.image}
      <button class="embed-picture" type="button" aria-label="View image" onclick={() => onview(e.image!)}>
        <img src={e.image} alt="" loading="lazy" onload={onresize} {@attach onresize} />
      </button>
    {:else if e}
      <div class="embed" class:large={e.large} style:--accent={e.color} {@attach onresize}>
        <div class="embed-text">
          {#if e.site}<span class="embed-site">{e.site}</span>{/if}
          {#if e.title}<a class="embed-title" href={e.url} target="_blank" rel="noreferrer noopener">{e.title}</a>{/if}
          {#if e.description}<p class="embed-description">{e.description}</p>{/if}
        </div>
        {#if e.image}
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
    font-size: 12px;
  }

  .embed-title {
    color: #a78bfa;
    font-size: 15px;
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
    font-size: 13px;
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
