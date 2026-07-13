// Content localization for admin-entered text (shop/service/barber names,
// shop description). Callers read the requested language from the `lang` query
// param and coalesce a base+Ar+Ckb triple down to one string.

export type Lang = "en" | "ar" | "ckb";

export function parseLang(raw: unknown): Lang {
  return raw === "ar" || raw === "ckb" ? raw : "en";
}

// Return the translation for `lang`, falling back to the base (English) value
// when the translation is missing or blank.
export function localize(
  lang: Lang,
  base: string,
  ar?: string | null,
  ckb?: string | null,
): string {
  if (lang === "ar") return ar?.trim() ? ar : base;
  if (lang === "ckb") return ckb?.trim() ? ckb : base;
  return base;
}
