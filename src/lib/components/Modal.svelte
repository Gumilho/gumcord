<script lang="ts">
  import type { Snippet } from "svelte";

  // A centred dialog over a dimmed backdrop. Escape or a click outside closes it.
  let { title, onclose, children }: { title: string; onclose: () => void; children: Snippet } = $props();

  // Focus the dialog's first field, so the keyboard lands in it.
  function focusFirst(node: HTMLElement) {
    node.querySelector<HTMLElement>("input, select, button")?.focus();
  }
</script>

<svelte:window onkeydown={(e) => { if (e.key === "Escape") onclose(); }} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="backdrop" onclick={onclose}>
  <div class="dialog" role="dialog" aria-modal="true" aria-label={title} tabindex="-1" onclick={(e) => e.stopPropagation()} use:focusFirst>
    <h2>{title}</h2>
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
