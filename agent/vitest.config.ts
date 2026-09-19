import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts", "test/property/**/*.test.ts", "test/wiring/**/*.test.ts"],
    environment: "node",
    // better-sqlite3 and the Dynamic MPC addon are native: forks are the known-good pool for them.
    pool: "forks",
  },
});
