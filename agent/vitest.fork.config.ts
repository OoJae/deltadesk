import { defineConfig } from "vitest/config";

/**
 * Fork e2e: anvil --fork-url $FORK_RPC_URL [--fork-block-number $FORK_BLOCK_NUMBER].
 * Every suite skips cleanly when FORK_RPC_URL is unset or anvil is not installed.
 */
export default defineConfig({
  test: {
    include: ["test/fork/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    globalSetup: ["test/fork/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
