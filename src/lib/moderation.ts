import { ApiError } from "./errors.js";

// Name moderation for the one-time display-name a user sets at first login.
//
// This is a SEED list, deliberately not exhaustive — "every" profanity or slur
// across English, Arabic and Kurdish is not something a static list can fully
// capture, and false negatives are expected. Extend `WORDS` (whole-word matches)
// and `SLURS` (substring matches, for terms that must be caught even when glued
// to other characters) as they surface. Keep the two lists lowercase and
// already normalized the way `normalize()` produces, or they will never match.
//
// Matching strategy:
//   * WORDS  — matched as whole tokens, so ordinary names that merely contain a
//              short banned string as a fragment ("Scunthorpe") are not blocked.
//   * SLURS  — matched as substrings of the separator-stripped form, so spacing
//              or punctuation evasion ("n i g ...") is still caught.

// Common profanity, matched whole-word. Compact on purpose.
const WORDS = new Set<string>([
  // English
  "fuck", "fucker", "fucking", "shit", "bitch", "bastard", "asshole", "cunt",
  "dick", "pussy", "whore", "slut", "wanker", "prick", "twat",
  // Arabic (transliteration-independent; stored as normalized Arabic)
  "كس", "طيز", "خرا", "شرموطة", "عرص", "منيك", "زب",
  // Kurdish (Sorani)
  "قوون", "كير", "كس", "خۆل",
]);

// Hard slurs, matched as substrings after separators are stripped. These must
// never appear in a public display name in any form.
const SLURS = [
  "nigger", "nigga", "faggot", "retard", "chink", "spic", "kike", "wetback",
  "tranny", "coon", "gook", "paki",
];

// Fold a name to a comparable form: lowercase, strip Latin and Arabic
// diacritics, unify Arabic letter variants, and undo common leetspeak so
// "Sh1t" / "f@ggot" don't slip through.
function normalize(input: string): string {
  let s = input.toLowerCase().normalize("NFKD");
  // Drop combining marks (Latin accents + Arabic tashkeel U+0610–U+061A,
  // U+064B–U+065F, U+0670).
  s = s.replace(/[̀-ͯؐ-ًؚ-ٰٟ]/g, "");
  // Unify Arabic alef/ya variants so one spelling of a banned word suffices.
  s = s
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");
  // Leetspeak digits/symbols to letters.
  const leet: Record<string, string> = {
    "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s",
  };
  s = s.replace(/[013457@$]/g, (c) => leet[c] ?? c);
  return s;
}

/// Throws ApiError (NAME_REJECTED) if [name] contains banned profanity or a
/// slur. Callers moderate the user-entered name before persisting it.
export function assertCleanName(name: string): void {
  const norm = normalize(name);
  const tokens = norm.split(/[^\p{L}]+/u).filter(Boolean);
  if (tokens.some((t) => WORDS.has(t))) {
    throw ApiError.badRequest("This name isn't allowed. Please choose another.", "NAME_REJECTED");
  }
  const collapsed = norm.replace(/[^\p{L}]+/gu, "");
  if (SLURS.some((slur) => collapsed.includes(slur))) {
    throw ApiError.badRequest("This name isn't allowed. Please choose another.", "NAME_REJECTED");
  }
}
