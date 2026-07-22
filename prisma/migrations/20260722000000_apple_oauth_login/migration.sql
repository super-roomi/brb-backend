-- Sign in with Apple: add the stable Apple account id (the identity token
-- `sub`). Null until a user's first Apple login; unique so two rows can't
-- claim the same Apple account. Users link primarily by this id because with
-- "Hide My Email" the address is an opaque @privaterelay.appleid.com relay
-- that can't be matched against a barber's real email.
ALTER TABLE "User" ADD COLUMN "appleId" TEXT;
CREATE UNIQUE INDEX "User_appleId_key" ON "User"("appleId");
