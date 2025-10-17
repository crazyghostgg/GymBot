//subscriptions.js
import db from "./db.js";

// сейчас активная подписка (окно now внутри [start_at, end_at))
export function getCurrentSubscription(userId) {
  return db
    .prepare(
      `
    SELECT * FROM subscriptions
    WHERE user_id = ?
      AND start_at <= datetime('now')
      AND end_at   > datetime('now')
    ORDER BY end_at DESC
    LIMIT 1
  `
    )
    .get(userId);
}

export function getNextSubscription(userId) {
  return db
    .prepare(
      `
    SELECT * FROM subscriptions
    WHERE user_id = ?
      AND start_at > datetime('now')
    ORDER BY start_at ASC
    LIMIT 1
  `
    )
    .get(userId);
}

// последняя по времени окончания
export function getLastSubscription(userId) {
  return db
    .prepare(
      `
    SELECT * FROM subscriptions
    WHERE user_id = ?
    ORDER BY end_at DESC
    LIMIT 1
  `
    )
    .get(userId);
}

export function hasAccess(userId) {
  return !!getCurrentSubscription(userId);
}

// удобный инсертер при approve платежа
export function addSubscription(userId, plan, startAtSql, endAtSql) {
  db.prepare(
    `
    INSERT INTO subscriptions (user_id, plan, start_at, end_at)
    VALUES (?,?,?,?)
  `
  ).run(userId, plan, startAtSql, endAtSql);
}
