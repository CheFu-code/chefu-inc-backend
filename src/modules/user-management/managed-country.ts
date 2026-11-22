import { Country } from "country-state-city";

export function managedCountry(
  profile: Record<string, unknown>,
): {
  code: string | null;
  name: string;
  source: "profile" | "detected";
} | null {
  const nested =
    profile.country &&
    typeof profile.country === "object" &&
    !Array.isArray(profile.country)
      ? (profile.country as Record<string, unknown>)
      : {};
  const legacy = text(profile.country);
  const code =
    countryCode(nested.code) ||
    countryCode(profile.countryCode) ||
    countryCode(legacy);
  const name = text(nested.name) || text(profile.countryName) || legacy;
  if (code)
    return {
      code,
      name: Country.getCountryByCode(code)!.name,
      source: "profile",
    };
  if (name) return { code: null, name, source: "profile" };
  const detected = countryCode(profile.detectedCountryCode);
  return detected
    ? {
        code: detected,
        name: Country.getCountryByCode(detected)!.name,
        source: "detected",
      }
    : null;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 100) : "";
}
function countryCode(value: unknown) {
  const code = text(value).toUpperCase();
  return /^[A-Z]{2}$/.test(code) && Country.getCountryByCode(code)
    ? code
    : null;
}
