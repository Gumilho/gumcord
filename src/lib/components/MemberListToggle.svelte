<script lang="ts">
  import { store } from "$lib/store.svelte.ts";
  import { t } from "$lib/i18n.svelte.ts";
  import { tooltip } from "$lib/tooltip.ts";
  import Icon from "$lib/components/Icon.svelte";

  // Shows or hides the member list; sits at the right end of the chat and call headers.
</script>

<button
  class="toggle"
  class:active={store.showMembers}
  type="button"
  aria-label={t("Member list")}
  aria-pressed={store.showMembers}
  use:tooltip={t(store.showMembers ? "Hide member list" : "Show member list")}
  onclick={() => store.toggleMembers()}
>
  <Icon name="members" />
</button>

<style>
  .toggle {
    display: flex;
    padding: 4px;
    border: none;
    border-radius: 4px;
    background: none;
    color: #8a90b4;
    cursor: pointer;
    transition: color 0.1s;
  }

  .toggle:hover,
  .toggle.active { color: #e4e6f5; }
</style>
