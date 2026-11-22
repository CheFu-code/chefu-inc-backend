import assert from "node:assert/strict";
import { test } from "node:test";
import { managedCountry } from "./managed-country";

test("saved country takes precedence over detected location and resolves display names", () => {
  assert.deepEqual(
    managedCountry({
      country: { code: " za ", name: "South Africa" },
      detectedCountryCode: "US",
    }),
    { code: "ZA", name: "South Africa", source: "profile" },
  );
  assert.deepEqual(managedCountry({ countryCode: "ZA" }), {
    code: "ZA",
    name: "South Africa",
    source: "profile",
  });
  assert.deepEqual(
    managedCountry({ country: {}, countryName: "South Africa" }),
    { code: null, name: "South Africa", source: "profile" },
  );
  assert.deepEqual(managedCountry({ country: "South Africa" }), {
    code: null,
    name: "South Africa",
    source: "profile",
  });
});

test("detected country is explicitly identified when no saved country is available", () => {
  assert.deepEqual(managedCountry({ detectedCountryCode: "za" }), {
    code: "ZA",
    name: "South Africa",
    source: "detected",
  });
});

test("missing or malformed country data is unknown rather than an invented location", () => {
  for (const profile of [
    {},
    { country: [] },
    { country: true },
    { countryCode: "ZZ", detectedCountryCode: "invalid" },
    { country: { code: {}, name: [] } },
  ])
    assert.equal(managedCountry(profile), null);
});
