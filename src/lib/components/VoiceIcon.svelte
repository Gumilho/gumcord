<script lang="ts">
  let {
    kind,
    slashed,
    size = 20,
  }: { kind: "mic" | "headphones"; slashed: boolean; size?: number } = $props();

  const uid = $props.id();
  const maskId = `voice-icon-gap-${uid}`;
</script>

<!-- Geometry from Discord's mic/deafen animations. Slashing draws the line from the top-right and cuts a gap around it. -->
<svg class:slashed width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <defs>
    <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
      <rect width="24" height="24" fill="white" />
      <path class="slash" d="M22 2 L2 22" stroke="black" stroke-width="6" stroke-linecap="round" />
    </mask>
  </defs>

  <g mask="url(#{maskId})">
    {#if kind === "mic"}
      <rect x="8" y="1.96" width="8" height="11.96" rx="4" fill="currentColor" />
      <path d="M5 9.92c0 3.87 3.13 7 7 7s7-3.13 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      <rect x="11" y="16.42" width="2" height="5" rx="0.5" fill="currentColor" />
      <rect x="8" y="19.92" width="8" height="2" rx="1" fill="currentColor" />
    {:else}
      <path
        transform="translate(12 12.3) scale(1.04)"
        fill="currentColor"
        d="M-8-.29C-8-4.71-4.42-8.29 0-8.29S8-4.71 8-.29c0 .69-.05 1.36-.15 2H6c-.94 0-1.83.45-2.4 1.2L1.63 5.54c-.47.63-.59 1.45-.33 2.18.59 1.61 2.59 2.57 4.18 1.41C8.84 6.7 10 3.38 10-.29 10-5.81 5.52-10.29 0-10.29S-10-5.81-10-.29c0 3.67 1.16 6.99 4.52 9.42 1.59 1.16 3.59.2 4.18-1.41.27-.73.15-1.55-.32-2.18L-3.6 2.91c-.57-.75-1.46-1.2-2.4-1.2h-1.85c-.1-.64-.15-1.31-.15-2Z"
      />
    {/if}
  </g>

  <path class="slash" d="M22 2 L2 22" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
</svg>

<style>
  /* Dash lengths use the real diagonal (≈28.3) rather than pathLength, which older WebKit ignores. */
  .slash {
    stroke-dasharray: 28.3 60;
    stroke-dashoffset: 28.3;
    opacity: 0;
    transition:
      stroke-dashoffset 0.18s ease-in,
      opacity 0s linear 0.18s;
  }

  .slashed .slash {
    stroke-dashoffset: 0;
    opacity: 1;
    transition:
      stroke-dashoffset 0.28s cubic-bezier(0.2, 0.8, 0.3, 1),
      opacity 0s;
  }

  @media (prefers-reduced-motion: reduce) {
    .slash,
    .slashed .slash {
      transition: none;
    }
  }
</style>
