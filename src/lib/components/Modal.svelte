<script lang="ts">
  import type { Snippet } from "svelte";
  import { dialogFocus } from "$lib/focus.ts";

  // A centred dialog over a dimmed backdrop. Escape or a click outside closes it. The keyboard lands
  // on its first control (not a hidden file input), stays inside while it's open, and goes back to
  // where it was when it closes.
  let { title, onclose, children }: { title: string; onclose: () => void; children: Snippet } = $props();
  const titleId = $props.id();
</script>

<svelte:window onkeydown={(e) => { if (e.key === "Escape") onclose(); }} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="backdrop" onclick={onclose}>
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabindex="-1" onclick={(e) => e.stopPropagation()} use:dialogFocus>
    <h2 id={titleId}>{title}</h2>
    {@render children()}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 150;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: #06071099;
  }

  .dialog {
    width: 100%;
    max-width: 440px;
    max-height: calc(100vh - 32px);
    overflow-y: auto;
    padding: 20px;
    border: 1px solid #2e3154;
    border-radius: 10px;
    background: #1e2035;
    box-shadow: 0 12px 40px #0009;
    color: #c8cce8;
  }

  h2 {
    margin: 0 0 16px;
    color: #e8eaf6;
    font-size: 17px;
  }
</style>
