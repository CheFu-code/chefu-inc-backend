import assert from "node:assert/strict";
import { test } from "node:test";
import { managedApps } from "./managed-apps";

test("apps expose registered names, activity dates, and revoked access without private fields", () => {
  const date = "2026-11-22T10:00:00.000Z";
  const apps = managedApps({
    cloudence: {
      enabled: true,
      firstSeenAt: { toDate: () => new Date(date) },
      lastSeenAt: date,
      secret: "private",
    },
    shopyethu: {
      enabled: false,
      firstSeenAt: null,
      lastSeenAt: { toDate: () => new Date(date) },
    },
  });
  assert.deepEqual(apps, [
    {
      id: "cloudence",
      name: "Cloudence",
      enabled: true,
      firstSeenAt: date,
      lastSeenAt: date,
    },
    {
      id: "shopyethu",
      name: "ShopYethu",
      enabled: false,
      firstSeenAt: null,
      lastSeenAt: date,
    },
  ]);
  assert.equal("secret" in apps[0], false);
});

test("absent or malformed app maps and entries do not break user pages", () => {
  for (const value of [undefined, null, false, "bad", []])
    assert.deepEqual(managedApps(value), []);
  assert.deepEqual(
    managedApps({ cloudence: null, root: true, shopyethu: [] }),
    [],
  );
});

test("legacy app IDs remain visible and invalid timestamps are safely omitted", () => {
  assert.deepEqual(
    managedApps({
      legacy: {
        firstSeenAt: "invalid",
        lastSeenAt: {
          toDate: () => {
            throw new Error("invalid date");
          },
        },
      },
    }),
    [
      {
        id: "legacy",
        name: "legacy",
        enabled: true,
        firstSeenAt: null,
        lastSeenAt: null,
      },
    ],
  );
});
