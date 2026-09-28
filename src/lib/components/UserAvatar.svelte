<script lang="ts">
  import { initial } from "$lib/avatar.ts";

  // Fills its container: the profile picture, or the name's initial when there's none (or it fails to load).
  let { name, src = "" }: { name: string; src?: string } = $props();
  let failed = $state(false);
  $effect(() => { src; failed = false; });
</script>

{#if src && !failed}
  <img {src} alt="" draggable="false" onerror={() => (failed = true)} />
{:else}
  {initial(name)}
{/if}

<style>
  img {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: inherit;
    object-fit: cover;
  }
</style>
