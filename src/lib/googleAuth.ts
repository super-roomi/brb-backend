import { OAuth2Client } from "google-auth-library";
import { env } from "../env.js";
import { ApiError } from "./errors.js";

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
    const ticket = await client.verifyIdToken({
      idToken,
      audience: env.googleClientIds,
    });
    payload = ticket.getPayload();
  } catch {
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
