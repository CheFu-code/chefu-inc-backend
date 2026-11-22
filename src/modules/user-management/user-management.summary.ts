import type { Firestore, Query } from "firebase-admin/firestore";
import { Timestamp } from "firebase-admin/firestore";

const DAY = 86_400_000;
export async function userManagementSummary(
  db: Firestore,
  days: number,
  now = Date.now(),
) {
  const users = db.collection("users");
  const count = async (query: Query) =>
    (await query.count().get()).data().count;
  const today = Math.floor(now / DAY) * DAY;
  const start = today - (days - 1) * DAY;
  const last30 = Timestamp.fromMillis(now - 30 * DAY);
  const [total, active, newUsers, admins] = await Promise.all([
    count(users),
    count(users.where("lastLoginAt", ">=", last30)),
    count(users.where("createdAt", ">=", last30)),
    count(users.where("roles", "array-contains", "admin")),
  ]);
  // Aggregate at most 15 intervals; never scan or return private user profiles.
  const step = Math.ceil(days / 15);
  const intervals = Array.from(
    { length: Math.ceil(days / step) },
    (_, index) => ({
      from: start + index * step * DAY,
      to: Math.min(today + DAY, start + (index + 1) * step * DAY),
    }),
  );
  const growth: Array<{ date: string; count: number }> = [];
  for (let offset = 0; offset < intervals.length; offset += 5) {
    growth.push(
      ...(await Promise.all(
        intervals.slice(offset, offset + 5).map(async ({ from, to }) => ({
          date: new Date(from).toISOString(),
          count: await count(
            users
              .where("createdAt", ">=", Timestamp.fromMillis(from))
              .where("createdAt", "<", Timestamp.fromMillis(to)),
          ),
        })),
      )),
    );
  }
  return {
    total,
    active,
    newUsers,
    admins,
    days,
    growth,
    roles: [
      { label: "Admins", count: admins },
      { label: "Other accounts", count: Math.max(0, total - admins) },
    ],
    generatedAt: new Date(now).toISOString(),
  };
}
