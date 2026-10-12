import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    clearMocks: true,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
      include: [
        "src/modules/ingestion/**/*.ts",
        "src/modules/normalization/**/*.ts",
        "src/modules/transactions/**/*.ts",
        "src/modules/validation/**/*.ts",
        "src/modules/reconciliation/**/*.ts",
        "src/modules/duplicates/**/*.ts",
        "src/modules/security/**/*.ts",
        "src/modules/api/**/*.ts",
        "src/modules/database/**/*.ts",
        "src/api/**/*.ts",
      ],
      exclude: ["**/*.d.ts", "**/node_modules/**"],
    },
  },
});
