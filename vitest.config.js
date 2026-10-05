import { defineConfig } from "vitest/config";
import { sveltekit } from "@sveltejs/kit/vite";

// Unit tests for the app's logic (src/lib). The SvelteKit plugin compiles the runes in the .svelte.ts stores.
export default defineConfig({
  plugins: [sveltekit()],
  resolve: { conditions: ["browser"] },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test-setup.ts"],
    restoreMocks: true,
  },
});
