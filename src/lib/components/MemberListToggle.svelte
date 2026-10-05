<script lang="ts">
  import { prefs } from "$lib/prefs.svelte.ts";
  import { t } from "$lib/i18n.svelte.ts";
  import { tooltip } from "$lib/tooltip.ts";
  import Icon from "$lib/components/Icon.svelte";

  // Shows or hides the member list; sits at the right end of the chat and call headers.
</script>

<button
  class="toggle"
  class:active={prefs.showMembers}
  type="button"
  aria-label={t("Member list")}
  aria-pressed={prefs.showMembers}
  use:tooltip={t(prefs.showMembers ? "Hide member list" : "Show member list")}
  onclick={() => prefs.toggleMembers()}
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
    color: #8e94b7;
    cursor: pointer;
    transition: color 0.1s;
  }

  .toggle:hover,
  .toggle.active { color: #e4e6f5; }

  /* No room beside the chat on a phone. */
  @media (max-width: 768px) {
    .toggle { display: none; }
  }
</style>
