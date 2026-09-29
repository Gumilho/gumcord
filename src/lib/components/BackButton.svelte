<script lang="ts">
  import { showNav } from "$lib/mobile.svelte.ts";
  import { t } from "$lib/i18n.svelte.ts";
  import Icon from "$lib/components/Icon.svelte";

  // Back to the channel list, on phone-sized screens only.
</script>

<button class="back" type="button" aria-label={t("Back to channels")} onclick={showNav}>
  <Icon name="chevron" size={22} />
</button>

<style>
  .back { display: none; }

  @media (max-width: 768px) {
    .back {
      display: flex;
      flex-shrink: 0;
      margin-left: -8px;
      padding: 6px;
      border: none;
      border-radius: 6px;
      background: none;
      color: #c8cce8;
      cursor: pointer;
    }

    /* The chevron points down; turned a quarter it points back. */
    .back :global(svg) { transform: rotate(90deg); }
    .back:active { background: #2a2c48; }
  }
</style>
