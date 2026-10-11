import { defineConfig } from "vitest/config";

// Hits the real APIs and spawns the built server: run `npm run build` first.
export default defineConfig({
  test: {
    include: ["test/live/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 180_000,
  },
});
