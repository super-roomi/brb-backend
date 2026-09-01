import { defineConfig } from "vitest/config";

// The guard in scripts/assert-test-db.mjs only runs from `npm test`'s pretest
// hook. A bare `npx vitest run` skipped it and wrote fixtures straight into
// whatever DATABASE_URL pointed at — which, in a working .env, is production.
// Running it as a setup file puts the check on every path into the suite.
export default defineConfig({
  test: {
    setupFiles: ["./tests/setup/assert-test-db.ts"],
  },
});
