<script lang="ts">
  import { initial } from "$lib/avatar.ts";

  // Fills its container: the picture, or letters when there's none (or it fails to load): the name's
  // initial by default. Server tiles use it too.
  let { name, src = "", letters }: { name: string; src?: string; letters?: string } = $props();
  let failed = $state(false);
  $effect(() => { src; failed = false; });
</script>

{#if src && !failed}
  <img {src} alt="" draggable="false" onerror={() => (failed = true)} />
{:else}
  {letters ?? initial(name)}
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
