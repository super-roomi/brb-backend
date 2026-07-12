// Safety guard for `npm test`: the test setup runs `prisma migrate reset`,
// which DROPS AND RECREATES the database in DATABASE_URL. Refuse to do that
// unless the target database name looks like a throwaway test DB, so a stray
// `npm test` against a dev/prod URL can't wipe real data.

const url = process.env.DATABASE_URL ?? "";
const dbName = url.split("/").pop()?.split("?")[0] ?? "";

if (!/test/i.test(dbName)) {
  console.error(
    `\n[test guard] Refusing to reset database "${dbName || "(unset)"}".\n` +
      `The test suite is destructive (prisma migrate reset). Point DATABASE_URL at a\n` +
      `throwaway database whose name contains "test", e.g.:\n\n` +
      `  DATABASE_URL='postgresql://user@localhost:5432/barberapp_test?schema=public' npm test\n`,
  );
  process.exit(1);
}
