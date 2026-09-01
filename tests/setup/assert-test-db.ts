import "dotenv/config"; // the app reads DATABASE_URL from .env; so must the guard

// Refuse to run the (destructive) suite against anything but a throwaway
// database. Mirrors scripts/assert-test-db.mjs, which guards `npm test`; this
// covers direct `vitest` invocations, which bypass the pretest hook entirely.
const url = process.env.DATABASE_URL ?? "";
const dbName = url.split("/").pop()?.split("?")[0] ?? "";

if (!/test/i.test(dbName)) {
  throw new Error(
    `\n[test guard] Refusing to run tests against database "${dbName || "(unset)"}".\n` +
      `The suite creates and deletes rows. Point DATABASE_URL at a throwaway\n` +
      `database whose name contains "test", e.g.:\n\n` +
      `  DATABASE_URL='postgresql://user@localhost:5432/barberapp_test?schema=public' npm test\n`,
  );
}
