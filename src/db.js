// db.js
import Database from "better-sqlite3";

const db = new Database("data.sqlite");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON"); // цілісність FK

db.exec(`
/* ===== Користувачі ===== */
CREATE TABLE IF NOT EXISTS users (
  user_id     INTEGER PRIMARY KEY,     -- Telegram id
  name        TEXT NOT NULL,
  room        TEXT NOT NULL,
  created_at  TEXT DEFAULT (datetime('now')),
  first_name  TEXT,
  last_name   TEXT,
  faculty     TEXT,                    -- 'НН ІАТЕ' | 'ІСЗІ'
  username    TEXT,                    -- @username або NULL
  registered  INTEGER NOT NULL DEFAULT 0,

  /* Абонементи / доступ */
  plan        TEXT,                    -- 'A' | 'B' | 'UNL' | NULL
  paid_until  TEXT,                    -- UTC 'YYYY-MM-DD HH:MM:SS' або NULL
  blocked     INTEGER NOT NULL DEFAULT 0  -- 1 = заблокований
);

/* ===== Сесії залу ===== */
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  captain_id INTEGER NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  status_chat_id INTEGER,
  status_message_id INTEGER,
  FOREIGN KEY(captain_id) REFERENCES users(user_id)
);

/* Рівно одна активна сесія */
CREATE UNIQUE INDEX IF NOT EXISTS one_active_session
  ON sessions(active)
  WHERE active = 1;

/* Відвідування */
CREATE TABLE IF NOT EXISTS visits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  entered_at TEXT NOT NULL DEFAULT (datetime('now')),
  exited_at  TEXT,
  FOREIGN KEY(session_id) REFERENCES sessions(id),
  FOREIGN KEY(user_id)    REFERENCES users(user_id)
);


/* Індекси для швидких вибірок відвідувань */
CREATE INDEX IF NOT EXISTS visits_open
  ON visits(session_id, exited_at);
CREATE INDEX IF NOT EXISTS visits_by_user
  ON visits(user_id, entered_at);
CREATE INDEX IF NOT EXISTS visits_current_cover
  ON visits(session_id, exited_at, user_id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_visits_open
  ON visits(session_id, user_id)
  WHERE exited_at IS NULL;

/* Журнал змін капітана (включно зі стартом сесії) */
CREATE TABLE IF NOT EXISTS captain_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  old_captain_id INTEGER,
  new_captain_id INTEGER NOT NULL,
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS captain_changes_s
  ON captain_changes(session_id, changed_at);

/* Покрокова реєстрація */
CREATE TABLE IF NOT EXISTS reg_state (
  user_id INTEGER PRIMARY KEY,
  step TEXT NOT NULL,          -- 'FIRST_NAME' | 'LAST_NAME' | 'ROOM' | 'FACULTY'
  tmp_first TEXT,
  tmp_last TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

/* ===== Платежі (напівручні) =====
   Статуси: 'pending' (заявка створена, чек не перевірено),
             'review'  (чек отримано, очікує рішення),
             'approved' (підтверджено, доступ надано/продовжено),
             'rejected' (відхилено).
*/
CREATE TABLE IF NOT EXISTS payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  plan          TEXT NOT NULL CHECK (plan IN ('A','B','UNL')),
  amount        INTEGER NOT NULL,                -- сума в копійках або грн (як вирішиш)
  proof_file_id TEXT,                            -- file_id фото/доку чека або NULL
  ref_code      TEXT NOT NULL UNIQUE,            -- унікальний референс (GYM-<uid>-<ts>)
  status        TEXT NOT NULL CHECK (status IN ('pending','review','approved','rejected')),
  comment       TEXT,                            -- причина відхилення тощо
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at   TEXT,
  rejected_at   TEXT,
  FOREIGN KEY(user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS payments_status
  ON payments(status, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_user_status
  ON payments(user_id, status, created_at DESC);

/* ===== Журнал дій суперадміна =====
   action: вільний рядок ('approve_payment','reject_payment','grant_manual','block_user','unblock_user', ...)
   details: JSON/текст із додатковою інформацією
*/
CREATE TABLE IF NOT EXISTS admin_actions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id        INTEGER NOT NULL,    -- хто виконав (суперадмін)
  action          TEXT NOT NULL,
  target_user_id  INTEGER,
  payment_id      INTEGER,
  details         TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(actor_id) REFERENCES users(user_id),
  FOREIGN KEY(target_user_id) REFERENCES users(user_id),
  FOREIGN KEY(payment_id) REFERENCES payments(id)
);


CREATE INDEX IF NOT EXISTS admin_actions_idx
  ON admin_actions(created_at DESC, action);
`);

/* ===== М'які міграції для вже існуючих БД (safe ALTER) =====
   Якщо база створена раніше — додамо відсутні колонки.
*/
try {
  db.exec(`ALTER TABLE users ADD COLUMN username TEXT`);
} catch {}
try {
  db.exec(`ALTER TABLE users ADD COLUMN plan TEXT`);
} catch {}
try {
  db.exec(`ALTER TABLE users ADD COLUMN paid_until TEXT`);
} catch {}
try {
  db.exec(`ALTER TABLE users ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0`);
} catch {}

/* На випадок, якщо дуже стара БД без faculty */
try {
  db.exec(`ALTER TABLE users ADD COLUMN faculty TEXT`);
} catch {}

/* Підстраховка: індекси можуть вже існувати */
try {
  db.exec(`CREATE INDEX payments_status ON payments(status, created_at DESC)`);
} catch {}
try {
  db.exec(
    `CREATE INDEX payments_user_status ON payments(user_id, status, created_at DESC)`
  );
} catch {}
try {
  db.exec(
    `CREATE INDEX admin_actions_idx ON admin_actions(created_at DESC, action)`
  );
} catch {}
try {
  db.exec(`CREATE INDEX visits_open ON visits(session_id, exited_at)`);
} catch {}
try {
  db.exec(`CREATE INDEX visits_by_user ON visits(user_id, entered_at)`);
} catch {}
try {
  db.exec(
    `CREATE INDEX captain_changes_s ON captain_changes(session_id, changed_at)`
  );
} catch {}
try {
  // Періодичні абонементи (щоб різні плани не "перетирали" один одного)
  db.exec(`
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  plan TEXT NOT NULL,            -- 'A' | 'B' | 'UNL'
  start_at TEXT NOT NULL,        -- UTC "YYYY-MM-DD HH:MM:SS"
  end_at   TEXT NOT NULL,        -- UTC "YYYY-MM-DD HH:MM:SS"
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(user_id) REFERENCES users(user_id)
);
CREATE INDEX IF NOT EXISTS idx_subs_user_time ON subscriptions(user_id, start_at, end_at);
`);
} catch {}
try {
  db.prepare(
    `ALTER TABLE payments ADD COLUMN months INTEGER NOT NULL DEFAULT 1`
  ).run();
} catch {}
try {
  db.prepare(
    `ALTER TABLE payments ADD COLUMN discount_percent INTEGER NOT NULL DEFAULT 0`
  ).run();
} catch {}
try {
  db.prepare(`ALTER TABLE payments ADD COLUMN amount_uah INTEGER`).run();
} catch {}
// users: terms_accepted_at (DATETIME), terms_version (INTEGER)
const usersCols = db
  .prepare(`PRAGMA table_info(users)`)
  .all()
  .map((c) => c.name);
if (!usersCols.includes("terms_accepted_at")) {
  db.prepare(`ALTER TABLE users ADD COLUMN terms_accepted_at TEXT`).run();
}
if (!usersCols.includes("terms_version")) {
  db.prepare(
    `ALTER TABLE users ADD COLUMN terms_version INTEGER DEFAULT 0`
  ).run();
}

export default db;
