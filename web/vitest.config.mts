import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  test: {
    include: ["test/**/*.test.{ts,tsx}", "lib/console/**/*.test.{ts,tsx}"],
    // Component tests opt into happy-dom per file; the route and lib tests run on plain Node.
    environment: "node",
    // Node's own (file-less, undefined) localStorage global would shadow happy-dom's.
    execArgv: ["--no-experimental-webstorage"],
  },
});
