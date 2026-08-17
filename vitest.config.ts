import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The scaffold lands before any suite does; an empty run is not a failure.
    passWithNoTests: true,
    // Each suite shells out to git and writes to temp dirs; give them room.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
