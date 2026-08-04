import { OAuth2Client } from "google-auth-library";
import { env } from "../env.js";
import { ApiError } from "./errors.js";
import { withTimeout } from "./timeout.js";

// Token verification fetches Google's signing certs, so it is a network call.
// Uncapped, a stalled fetch holds the request (and its rate-limit slot) until
// the server-wide 30s timeout.
const VERIFY_TIMEOUT_MS = 8_000;

// Verified identity extracted from a Google ID token.
export interface GoogleIdentity {
  googleId: string; // `sub` claim — stable per Google account
  email: string; // lowercased
  name: string | null;
}

const client = new OAuth2Client();

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  if (!env.googleConfigured) {
    // GOOGLE_CLIENT_ID is still the checked-in placeholder. Verifying against
    // it would reject every real token with a confusing "wrong audience".
    throw new ApiError(
      503,
      "GOOGLE_NOT_CONFIGURED",
      "Google Sign-In is not configured on this server yet",
    );
  }

  let payload;
  try {
    const ticket = await withTimeout(
      client.verifyIdToken({ idToken, audience: env.googleClientIds }),
      VERIFY_TIMEOUT_MS,
      "google.verifyIdToken",
    );
    payload = ticket.getPayload();
  } catch (err) {
    // A timeout is us failing, not the caller's token being bad. Say so, so a
    // Google outage surfaces as a retryable 503 in the app instead of bouncing
    // the user to the login screen with "sign-in failed".
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new ApiError(
        503,
        "GOOGLE_UNAVAILABLE",
        "Could not reach Google to verify your sign-in. Try again.",
      );
    }
    throw ApiError.unauthorized("Google sign-in failed", "GOOGLE_TOKEN_INVALID");
  }

  if (!payload?.sub || !payload.email) {
    throw ApiError.unauthorized("Google sign-in failed", "GOOGLE_TOKEN_INVALID");
  }
  // An unverified email could impersonate someone else's future account (and
  // barbers are linked by email), so require Google's verification bit.
  if (!payload.email_verified) {
    throw ApiError.unauthorized(
      "Google account email is not verified",
      "GOOGLE_EMAIL_UNVERIFIED",
    );
  }

  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase(),
    name: payload.name ?? null,
  };
}
