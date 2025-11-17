// index.js
import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import { formatInTimeZone } from "date-fns-tz";
import db from "./db.js";
import { updateStatusPost } from "./statusPost.js";
import {
  getCurrentSubscription,
  getNextSubscription,
  getLastSubscription,
  hasAccess,
  addSubscription,
} from "./subscriptions.js";
const bot = new Telegraf(process.env.BOT_TOKEN);
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID?.trim() || null;
const PAYMENT_DETAILS =
  process.env.PAYMENT_DETAILS || "IBAN UA 72 322001 00000 2620 1363 6547 59";

/* ===== Загальні константи пагінації та лімітів ===== */
const TELEGRAM_SAFE_LIMIT = 3800; // трохи менше 4096
const SUBS_PER_PAGE = 30;
const USERS_PER_PAGE = 20;
const PRICE_UAH = { A: 119, B: 119, UNL: 229 };
const MONTHS_MIN = 1;
const MONTHS_MAX = 9;
const CURRENT_TERMS_VERSION = 2;
const WATCH_CHAT_IDS = (process.env.WATCH_CHAT_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

// ✅ БЕЛЫЙ СПИСОК, кто может становиться «вахтёром»
const WATCHER_ALLOW = new Set(
  (process.env.WATCHER_ALLOW_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
);

// ✅ Таблица для динамичных вахтёров (если ещё не создана)
db.prepare(
  `CREATE TABLE IF NOT EXISTS watchers (
     user_id INTEGER PRIMARY KEY
   )`
).run();

// ✅ Функции работы с вахтёрами (+ белый список)
function isWatcher(userId) {
  return !!db.prepare(`SELECT 1 FROM watchers WHERE user_id=?`).get(userId);
}
function setWatcher(userId, on) {
  if (!WATCHER_ALLOW.has(Number(userId))) return false;
  if (on) {
    db.prepare(`INSERT OR IGNORE INTO watchers (user_id) VALUES (?)`).run(
      userId
    );
  } else {
    db.prepare(`DELETE FROM watchers WHERE user_id=?`).run(userId);
  }
  return true;
}

async function notifyWatchers(text, extra = {}) {
  const rows = db.prepare(`SELECT user_id FROM watchers`).all() || [];
  const dynamicIds = rows.map((r) => Number(r.user_id));
  const staticIds = (WATCH_CHAT_IDS || []).map(Number);
  const all = Array.from(new Set([...dynamicIds, ...staticIds]));
  if (!all.length) return;

  const tasks = all.map((id) =>
    bot.telegram
      .sendMessage(id, text, {
        parse_mode: "HTML",
        disable_notification: false,
        ...extra,
      })
      .catch((err) => {
        console.error("notifyWatchers error -> id:", id, err?.message || err);
      })
  );
  await Promise.allSettled(tasks);
}
function makeRef() {
  const rnd = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, "0");
  return `${rnd}`;
}
function clampMonths(m) {
  return Math.min(MONTHS_MAX, Math.max(MONTHS_MIN, parseInt(m || "1", 10)));
}
function calcDiscountPct(months) {
  return Math.max(0, Math.min(24, (months - 1) * 3)); // 2 міс → 3%, 4 міс → 9%, 9 міс → 24%
}
function calcTotalUAH(plan, months) {
  const base = PRICE_UAH[plan];
  const pct = calcDiscountPct(months);
  return Math.round(base * months * (1 - pct / 100));
}
const TERMS_HTML = [
  "<b>Правила користування спортзалом</b>",
  "",
  "Зал працює <b>сесіями</b>. Перший, хто відкриває сесію в боті — <b>капітан</b>.",
  "<u>Якщо ви не готові бути капітаном — залом не користуєтесь.</u>",
  "",
  "<b>Капітан відповідає за:</b>",
  "• порядок у залі;",
  "• контроль відміток «Увійти/Вийти» в боті для всіх;",
  "• коректне завершення сесії (зачинити вікна, вимкнути світло, замкнути двері, повернути ключ).",
  "",
  "<b>Як користуватись:</b>",
  "1) Візьміть ключ на вахті під підпис.",
  "2) У боті натисніть «Почати сесію» (станете капітаном) або «Увійти», якщо сесію вже відкрито.",
  "3) Під час тренування кожен обов’язково відмічає «Увійти/Вийти» у боті.",
  "4) Якщо ви капітан і йдете, а хтось лишається — <b>передайте капітанство</b> у боті.",
  "5) Якщо ви останні: закрийте сесію, зачиніть вікна, вимкніть світло, замкніть двері і поверніть ключ.",
  "",
  "<b>Відповідальність:</b>",
  "• Якщо щось зламалося/зникло під час сесії — відповідають <b>усі, хто був усередині</b> (або винний, якщо зізнається).",
  "• Якщо капітан не проконтролював вхід/вихід — <b>відповідальність на капітані</b>.",
  "• Якщо забули зачинити двері — <b>відповідає той, хто забув</b>.",
  "",
  "<b>Анулювання абонементу(без повернення коштів)</b>",
  "Може бути застосовано при порушенні правил нижче. Або письмове пояснення про причину порушення, на розгляд завідуючої гуртожитком.",
  "• систематичні порушення правил користування спортзалом/ботом;",
  "• небезпечні дії;",
  "• обман з оплатою або гостями;",
  "• ігнорування обов’язків капітана.",
  "• відмова написати письмове пояснення після першого порушення",
  "",
  "⚠️ Оплачуючи абонемент, ви погоджуєтесь з правилами і несете відповідальність за свої дії.",
].join("\n");

/* ===== Час, ролі, утиліти ===== */
const TZ = process.env.TZ || "Europe/Kyiv";

const ADMINS = new Set(
  (process.env.ADMINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((v) => Number(v))
);

const SUPER_ADMINS = new Set(
  (process.env.SUPER_ADMINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((v) => Number(v))
);
// HTML-екранування (працює на будь-якій версії Node)
const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

// суперадмін => теж адмін
function isSuperAdmin(id) {
  return SUPER_ADMINS.has(Number(id));
}
function isAdmin(id) {
  if (isSuperAdmin(id)) return true;
  // якщо ADMINS порожній — не обмежуємо (як у твоєму попередньому коді)
  return ADMINS.size === 0 || ADMINS.has(Number(id));
}
function notifyCaptain(s, text, exceptUserId = null) {
  if (!s?.captain_id) return;
  if (exceptUserId && Number(exceptUserId) === Number(s.captain_id)) return; // не спамити, якщо автор = капітан
  return bot.telegram
    .sendMessage(s.captain_id, text, { disable_notification: true })
    .catch(() => {}); // на випадок, якщо капітан заблокував бота / не відкривав чат
}
function getUserById(userId) {
  return db.prepare(`SELECT * FROM users WHERE user_id = ?`).get(userId);
}

function hasAcceptedTerms(u) {
  return u?.terms_version >= CURRENT_TERMS_VERSION && u?.terms_accepted_at;
}

async function showTermsGate(ctx) {
  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "✅ Прочитав та погоджуюсь",
        `accept_terms:${CURRENT_TERMS_VERSION}`
      ),
    ],
  ]);
  return ctx.reply(TERMS_HTML, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: kb.reply_markup,
  });
}

bot.action(/copy_ref:(.+)/, async (ctx) => {
  const ref = ctx.match[1];
  await ctx.answerCbQuery("Відкриваю референс… (утримуйте, щоб скопіювати)");
  return ctx.replyWithHTML(`<b>Референс-код</b>\n<code>${esc(ref)}</code>`);
});

bot.action("copy_details", async (ctx) => {
  await ctx.answerCbQuery("Відправляю реквізити…");
  return ctx.replyWithHTML(
    `<b>Реквізити</b>\n<pre><code>${esc(PAYMENT_DETAILS)}</code></pre>`
  );
});

bot.action("how_receipt", async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.replyWithHTML(
    [
      "🧾 <b>Як надіслати квитанцію</b>",
      "• Фото: чітко видно суму, дату, призначення <u>з референсом</u>.",
      "• PDF: оригінал з банку.",
      "Після надсилання статус: <code>review</code>. Адміністратор перевіряє й активує підписку.",
    ].join("\n")
  );
});

// Согласие с правилами и продолжение к оплате
bot.action(/accept_terms:(\d+)/, async (ctx) => {
  const version = Number(ctx.match[1] || 0);
  const userId = ctx.from.id;

  // сохраняем отметку о согласии (нужны поля в БД — см. примечание ниже)
  db.prepare(
    `
    UPDATE users
    SET terms_accepted_at = datetime('now'),
        terms_version = ?
    WHERE user_id = ?
  `
  ).run(version, userId);

  await ctx.answerCbQuery("Дякуємо!");
  try {
    await ctx.editMessageReplyMarkup();
  } catch {}

  // сразу открываем выбор планов
  return renderPlanSelect(ctx);
});

// формат часу і SQL-рядки
const toLocal = (s) =>
  s
    ? formatInTimeZone(
        new Date(s.replace(" ", "T") + "Z"),
        TZ,
        "yyyy-MM-dd HH:mm"
      )
    : "—";
const nowSql = () => new Date().toISOString().slice(0, 19).replace("T", " ");

function daysTextForPlan(plan) {
  if (plan === "A") return "Пн/Ср/Пт/Нд";
  if (plan === "B") return "Вт/Чт/Сб/Нд";
  if (plan === "UNL") return "будь-який день";
  return "—";
}

/* === Читабельні назви та описи планів === */
function planName(code) {
  if (code === "A") return "1 План";
  if (code === "B") return "2 План";
  if (code === "UNL") return "UNLIMITED";
  return code || "—";
}
function planDescription(code) {
  if (code === "A") return "Відвідування: Пн/Ср/Пт/Нд";
  if (code === "B") return "Відвідування: Вт/Чт/Сб/Нд";
  if (code === "UNL") return "Відвідування: будь-який день";
  return "";
}

/* ===== Доступ за планом та станом оплати ===== */

// дозволені дні тижня за планом (ISO-день: 1=Пн ... 7=Нд)
function isAllowedToday(plan) {
  const isoDay = parseInt(formatInTimeZone(new Date(), TZ, "i"), 10); // 1..7
  if (plan === "UNL") return true;
  if (plan === "A") return [1, 3, 5, 7].includes(isoDay); // Пн/Ср/Пт/Нд
  if (plan === "B") return [2, 4, 6, 7].includes(isoDay); // Вт/Чт/Сб/Нд
  return false;
}

function isPlanAllowedForFaculty(_faculty, plan) {
  return plan === "A" || plan === "B" || plan === "UNL";
}

function isPaid(user) {
  // Новий механізм: активний підпис зараз є в subscriptions
  const sub = getCurrentSubscription(user.user_id);
  if (sub) return true;
  return false;
}

/* ===== Утиліти БД ===== */
const getActiveSession = () =>
  db.prepare(`SELECT * FROM sessions WHERE active=1`).get();

const getOpenVisit = (sessionId, userId) =>
  db
    .prepare(
      `SELECT * FROM visits WHERE session_id=? AND user_id=? AND exited_at IS NULL`
    )
    .get(sessionId, userId);

const countParticipants = (sessionId) =>
  db
    .prepare(
      `SELECT COUNT(*) as c FROM visits WHERE session_id=? AND exited_at IS NULL`
    )
    .get(sessionId).c;

const listParticipants = (sessionId) =>
  db
    .prepare(
      `SELECT u.user_id, u.name
       FROM visits v JOIN users u ON u.user_id=v.user_id
       WHERE v.session_id=? AND v.exited_at IS NULL ORDER BY u.name`
    )
    .all(sessionId);

const getUser = (id) =>
  db.prepare(`SELECT * FROM users WHERE user_id=?`).get(id);

const getNameById = (id) =>
  db.prepare(`SELECT name FROM users WHERE user_id=?`).get(id)?.name || "—";

function sqlFromDate(d) {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/* ===== Глобальний перехоплювач помилок Telegraf ===== */
bot.catch((err) => {
  console.error("Unhandled bot error:", err);
});

/* ===== Безпечна відправка/редагування тексту ===== */
async function sendOrEdit(ctx, text, extra = {}) {
  try {
    // якщо виклик із callback — пробуємо редагувати
    if (ctx.update?.callback_query?.message) {
      await ctx.editMessageText(text, extra);
    } else {
      await ctx.reply(text, extra);
    }
  } catch (e) {
    // fallback: просто нове повідомлення
    try {
      await ctx.reply(text, extra);
    } catch (e2) {
      console.error("sendOrEdit failed:", e2);
    }
  }
}
/* ===== КОМАНДА PUSHSTATUS ===== */
bot.command("pushstatus", async (ctx) => {
  try {
    await updateStatusPost(bot, GROUP_CHAT_ID);
    return ctx.reply("Статус оновлено.");
  } catch (e) {
    console.error("pushstatus error:", e);
    return ctx.reply("Помилка оновлення статусу: " + (e.message || e));
  }
});
bot.action(/cancel_payment:(.+)/, async (ctx) => {
  const ref = ctx.match[1];

  const row = db
    .prepare(
      `
    SELECT id, status FROM payments
    WHERE user_id = ? AND ref_code = ?
    ORDER BY created_at DESC LIMIT 1
  `
    )
    .get(ctx.from.id, ref);

  if (!row) {
    return ctx.answerCbQuery("Заявку не знайдено", { show_alert: true });
  }
  if (!["pending", "review"].includes(row.status)) {
    return ctx.answerCbQuery("Цю заявку вже оброблено, скасувати не можна.", {
      show_alert: true,
    });
  }

  // ✅ Сумісно з CHECK-обмеженням
  db.prepare(`UPDATE payments SET status = 'rejected' WHERE id = ?`).run(
    row.id
  );

  // Прибрати кнопку «Скасувати» з повідомлення заявки
  try {
    await ctx.editMessageReplyMarkup({
      inline_keyboard: [
        [Markup.button.callback("📎 Референс-код", `copy_ref:${ref}`)],
        [Markup.button.callback("🏦 Реквізити", "copy_details")],
      ],
    });
  } catch {}

  await ctx.answerCbQuery("Заявку скасовано.");
  return ctx.reply("❌ Заявку скасовано (статус: rejected).");
});
/* ===== Покрокова реєстрація ===== */
const getRegState = (id) =>
  db.prepare(`SELECT * FROM reg_state WHERE user_id=?`).get(id);
const setRegState = (id, step, tmp_first = null, tmp_last = null) => {
  const row = getRegState(id);
  if (row) {
    db.prepare(
      `UPDATE reg_state SET step=?, tmp_first=?, tmp_last=? WHERE user_id=?`
    ).run(step, tmp_first, tmp_last, id);
  } else {
    db.prepare(
      `INSERT INTO reg_state (user_id, step, tmp_first, tmp_last) VALUES (?,?,?,?)`
    ).run(id, step, tmp_first, tmp_last);
  }
};
const clearRegState = (id) =>
  db.prepare(`DELETE FROM reg_state WHERE user_id=?`).run(id);

const NAME_RE = /^[A-Za-zА-Яа-яЁёІіЇїЄє' -]{2,30}$/;
const ROOM_RE = /^[0-9]{1,4}[A-Za-zА-Яа-я-]{0,2}$/;

/* Кнопки вибору факультету */
const FACULTY_MAP = { IATE: "НН ІАТЕ", ISZI: "ІСЗІ" };
const facultyKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback("НН ІАТЕ", "reg:fac:IATE")],
    [Markup.button.callback("ІСЗІ", "reg:fac:ISZI")],
  ]);

function promptFaculty(ctx) {
  return ctx.reply(
    "В якому факультеті Ви навчаєтесь? Оберіть варіант:",
    facultyKeyboard()
  );
}

function startRegistration(ctx) {
  const uid = ctx.from.id;
  clearRegState(uid);
  setRegState(uid, "FIRST_NAME");
  return ctx.reply("Реєстрація.\nВведіть ваше *ім'я* (2–30 символів).", {
    parse_mode: "Markdown",
  });
}

function requireRegistered(ctx) {
  const uid = ctx.from.id;
  const u = getUser(uid);
  if (u && u.registered) return u;

  const rs = getRegState(uid);
  if (rs?.step === "FACULTY") {
    promptFaculty(ctx);
    return null;
  }

  startRegistration(ctx);
  return null;
}

/* Перехоплення тексту під час реєстрації */
bot.on("text", (ctx, next) => {
  const uid = ctx.from?.id;
  if (!uid) return next();

  const rs = getRegState(uid);
  if (!rs) return next();

  const text = (ctx.message.text || "").trim();

  if (rs.step === "FIRST_NAME") {
    if (!NAME_RE.test(text))
      return ctx.reply(
        "Ім'я виглядає дивно. Введіть *лише ім'я* (2–30 символів).",
        { parse_mode: "Markdown" }
      );
    setRegState(uid, "LAST_NAME", text, rs.tmp_last);
    return ctx.reply("Тепер введіть ваше *прізвище*.", {
      parse_mode: "Markdown",
    });
  }

  if (rs.step === "LAST_NAME") {
    if (!NAME_RE.test(text))
      return ctx.reply(
        "Прізвище виглядає дивно. Введіть *лише прізвище* (2–30 символів).",
        { parse_mode: "Markdown" }
      );
    setRegState(uid, "ROOM", rs.tmp_first, text);
    return ctx.reply("Номер кімнати (наприклад, *412*).", {
      parse_mode: "Markdown",
    });
  }

  if (rs.step === "ROOM") {
    if (!ROOM_RE.test(text))
      return ctx.reply(
        "Вкажіть номер кімнати (1–4 цифри, можна літеру: 412А)."
      );
    const room = text;
    const first = rs.tmp_first;
    const last = rs.tmp_last;

    const u = getUser(uid);
    const username = ctx.from?.username || null;
    if (u) {
      db.prepare(
        `UPDATE users
         SET first_name=?, last_name=?, name=?, room=?, username=?, registered=0
         WHERE user_id=?`
      ).run(first, last, `${first} ${last}`, room, username, uid);
    } else {
      db.prepare(
        `INSERT INTO users (user_id, name, room, first_name, last_name, username, registered)
         VALUES (?,?,?,?,?,?,0)`
      ).run(uid, `${first} ${last}`, room, first, last, username);
    }
    setRegState(uid, "FACULTY");
    return promptFaculty(ctx);
  }

  if (rs.step === "FACULTY") {
    return ctx.reply("Будь ласка, оберіть варіант *кнопками нижче*.", {
      parse_mode: "Markdown",
      ...facultyKeyboard(),
    });
  }

  return next();
});

/* ===== Клавіатура ===== */
function mainKeyboard(userId, session, inside) {
  const kb = [];

  // завжди доступно
  kb.push(["Оплатити", "Мій абонемент"]);

  if (session) {
    if (inside) kb.push(["Вийти"]);
    else kb.push(["Увійти"]);

    const isCaptain = session.captain_id === userId;
    if (isCaptain) kb.push(["Передати капітана"]); // завжди видима капітану
  } else {
    kb.push(["Почати сесію"]);
  }

  // ✅ Кнопки вахтёра — только тем, кто в белом списке
  if (WATCHER_ALLOW.has(Number(userId))) {
    const watcherOn = isWatcher(userId);
    kb.push([watcherOn ? "❌ Вийти з вахти" : "👮 Встати на вахту"]);
  }

  kb.push(["Статус"]);
  if (isAdmin(userId)) kb.push(["Меню Адміна"]);

  return Markup.keyboard(kb).resize();
}

/* ===== /start — показ профілю/реєстрації ===== */
bot.command("chatid", (ctx) => ctx.reply(`Chat ID: ${ctx.chat.id}`));
bot.start((ctx) => {
  const uid = ctx.from.id;
  const u = getUser(uid);
  const s = getActiveSession();
  const inside = s ? !!getOpenVisit(s.id, uid) : false;

  if (!u || !u.registered) {
    const rs = getRegState(uid);
    if (rs?.step === "FACULTY") return promptFaculty(ctx);
    return startRegistration(ctx);
  }

  const full = `${u.first_name || ""} ${u.last_name || ""}`.trim() || u.name;
  return ctx.reply(
    `Ви вже зареєстровані.\nІм'я: ${full}\nКімната: ${u.room}${
      u.faculty ? `\nФакультет: ${u.faculty}` : ""
    }`,
    mainKeyboard(uid, s, inside)
  );
});

/* ===== Реакція на вибір факультету ===== */
bot.on("callback_query", async (ctx, next) => {
  const data = ctx.callbackQuery.data || "";

  // вибір факультету
  if (data.startsWith("reg:fac:")) {
    const code = data.split(":")[2]; // IATE | ISZI
    const faculty = { IATE: "НН ІАТЕ", ISZI: "ІСЗІ" }[code] || null;
    const uid = ctx.from.id;
    if (!faculty) {
      await ctx.answerCbQuery("Невідомий варіант.");
      return;
    }
    db.prepare(`UPDATE users SET faculty=?, registered=1 WHERE user_id=?`).run(
      faculty,
      uid
    );
    clearRegState(uid);

    const s = getActiveSession();
    const inside = s ? !!getOpenVisit(s.id, uid) : false;
    const u = getUser(uid);
    const full = `${u.first_name || ""} ${u.last_name || ""}`.trim() || u.name;

    await ctx.editMessageText(
      `Дякуємо! Реєстрацію завершено.\nІм'я: ${full}\nКімната: ${u.room}\nФакультет: ${faculty}`
    );
    await ctx.reply(
      "Можете користуватися кнопками нижче.",
      mainKeyboard(uid, s, inside)
    );
    await ctx.answerCbQuery("Збережено.");
    return;
  }

  return next();
});

/* ===== ПРОФІЛЬ: Мій абонемент ===== */
bot.hears("Мій абонемент", async (ctx) => {
  const u = requireRegistered(ctx);
  if (!u) return;

  const s = getActiveSession();
  const inside = s ? !!getOpenVisit(s.id, u.user_id) : false;

  const cur = getCurrentSubscription(u.user_id);
  const next = getNextSubscription(u.user_id);

  let text = "";
  if (cur) {
    text += `Статус абонемента: *активний*\n`;
    text += `Поточний план: ${planName(cur.plan)}\n${planDescription(
      cur.plan
    )}\n`;
    text += `Період: ${toLocal(cur.start_at)} → ${toLocal(cur.end_at)}\n`;
  } else {
    text += `Статус абонемента: *немає доступу*\n`;
  }

  if (next) {
    text += `\nНаступний період:\n`;
    text += `${planName(next.plan)}\n${planDescription(next.plan)}\n`;
    text += `Період: ${toLocal(next.start_at)} → ${toLocal(next.end_at)}\n`;
  }

  const kb = mainKeyboard(u.user_id, s, inside);
  await ctx.reply(text.trim(), {
    parse_mode: "Markdown",
    reply_markup: kb.reply_markup,
  });
});

/* ===== ОПЛАТА (напівручна) ===== */

// Меню оплати
// helper: показать выбор планов (чтобы вызывать и после согласия)
async function renderPlanSelect(ctx, u) {
  const user = u || getUser(ctx.from.id);
  // Фильтрация планов по факультету (ІСЗІ: только A/B; ІАТЕ: + UNL)
  const rows = [
    [Markup.button.callback("1 План (119₴/міс)", "pay:plan:A")],
    [Markup.button.callback("2 План (119₴/міс)", "pay:plan:B")],
    [Markup.button.callback("UNLIMITED (229₴/міс)", "pay:plan:UNL")],
  ];

  const text =
    "Оберіть тип абонемента:\n" +
    "• 1 План — Пн/Ср/Пт/Нд\n" +
    "• 2 План — Вт/Чт/Сб/Нд\n" +
    "• UNLIMITED — без обмежень за днями";

  return ctx.reply(text, Markup.inlineKeyboard(rows));
}

// Меню оплати (теперь с гейтом правил)
bot.hears("Оплатити", async (ctx) => {
  const u = requireRegistered(ctx);
  if (!u) return;

  // если пользователь ещё не подтвердил правила — показываем гейт и выходим
  if (!hasAcceptedTerms(u)) {
    return showTermsGate(ctx);
  }

  // уже согласился — показываем выбор планов
  return renderPlanSelect(ctx, u);
});

// === НОВЕ: Після вибору ПЛАНУ показуємо вибір місяців 1–9 із знижкою
bot.on("callback_query", async (ctx, next) => {
  const data = ctx.callbackQuery.data || "";
  if (!data.startsWith("pay:plan:")) return next();

  const plan = data.split(":")[2]; // A|B|UNL
  const uid = ctx.from.id;
  const u = getUser(uid);
  if (!u || !u.registered) {
    await ctx.answerCbQuery("Спочатку завершіть реєстрацію.", {
      show_alert: true,
    });
    return;
  }

  if (!isPlanAllowedForFaculty(u.faculty, plan)) {
    await ctx.answerCbQuery("Цей план недоступний для вашого факультету.", {
      show_alert: true,
    });
    return;
  }

  const rows = [];
  for (let m = 1; m <= 9; m++) {
    const total = calcTotalUAH(plan, m);
    const pct = calcDiscountPct(m);
    rows.push([
      Markup.button.callback(
        `${m} міс. — ${total}₴${pct ? ` (-${pct}%)` : ""}`,
        `pay:months:${plan}:${m}`
      ),
    ]);
  }

  await sendOrEdit(
    ctx,
    "Оберіть тривалість абонемента (1–9 місяців). Знижка застосовується до всього чеку.",
    Markup.inlineKeyboard(rows)
  );
  await ctx.answerCbQuery().catch(() => {});
});

// === НОВЕ: Після вибору кількості місяців — створюємо pending із months/discount/amount_uah
bot.on("callback_query", async (ctx, next) => {
  const data = ctx.callbackQuery.data || "";
  if (!data.startsWith("pay:months:")) return next();
  {
    // Формат: pay:months:<PLAN>:<M>
    const [, , plan, mStr] = data.split(":");
    if (!["A", "B", "UNL"].includes(plan)) {
      await ctx.answerCbQuery("Невідомий план.");
      return;
    }
    const months = clampMonths(mStr);
    const pct = calcDiscountPct(months);
    const amountUAH = calcTotalUAH(plan, months); // сума в грн з урахуванням знижки
    const amount = amountUAH * 100; // у копійках для payments.amount (NOT NULL)
    const u = getUser(ctx.from.id);
    if (!u) {
      await ctx.answerCbQuery("Зареєструйтеся, будь ласка.");
      return;
    }
    const ref = makeRef(u.user_id); // як і було
    const details = PAYMENT_DETAILS; // тепер беремо з константи/.env

    // створюємо заявку (без колонки details — вона й не потрібна)
    db.prepare(
      `
  INSERT INTO payments (
    user_id, plan, amount, amount_uah, ref_code, status, months, discount_percent, created_at
  ) VALUES (?,?,?,?,?, 'pending', ?, ?, datetime('now'))
`
    ).run(u.user_id, plan, amount, amountUAH, ref, months, pct);

    // HTML повідомлення з акцентами
    const messageHtml = [
      "┏━━ <b>ЗАЯВКУ СТВОРЕНО</b> ━━┓",
      `<b>${esc(planName(plan))}</b>`,
      `${esc(planDescription(plan))}`,
      `Тривалість: <b>${months} міс.</b>`,
      `Знижка: <b>${pct}%</b>`,
      `До сплати: <b>${amountUAH}₴</b>`,
      "",
      "⚠️ <u><b>ВАЖЛИВО: РЕФЕРЕНС-КОД</b></u>",
      `<code>${esc(ref)}</code>`,
      "Додайте цей код у призначенні платежу <b>без змін</b>.",
      "",
      "<b>Реквізити для оплати</b>",
      `<pre><code>${esc(details)}</code></pre>`,
      "",
      "<b>Що далі</b>",
      "1) Оплатіть за реквізитами з референсом.",
      "2) Надішліть квитанцію сюди (фото або PDF).",
      "3) Очікуйте підтвердження від адміністратора.",
    ].join("\n");

    // Кнопки: референс, реквізити, СКАСУВАТИ
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback("📎 Референс-код", `copy_ref:${ref}`)],
      [Markup.button.callback("🏦 Реквізити", "copy_details")],
      [Markup.button.callback("❌ Скасувати заявку", `cancel_payment:${ref}`)],
    ]);

    // ... после формирования messageHtml и kb
    await sendOrEdit(ctx, messageHtml, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: kb.reply_markup,
    });

    await ctx.answerCbQuery("Заявка створена.").catch(() => {});

    notifySupers(
      `🆕 Нова заявка: ${u.name} (id:${u.user_id}) — ${planName(
        plan
      )}, ${months} міс., -${pct}%, сума ${amountUAH}₴, ref=${ref}`
    );

    await ctx.answerCbQuery("Заявка створена.").catch(() => {});
    return;
  }
});
/* ===== Прийом квитанції: фото/документ → status: review ===== */
bot.on(["photo", "document"], async (ctx) => {
  const uid = ctx.from.id;
  const u = getUser(uid);
  if (!u || !u.registered) return; // лише зареєстровані

  // Беремо останню активну заявку цього користувача
  const p = db
    .prepare(
      `
    SELECT * FROM payments
    WHERE user_id = ? AND status IN ('pending','review')
    ORDER BY created_at DESC
    LIMIT 1
  `
    )
    .get(uid);

  if (!p) {
    return ctx.reply(
      "У вас немає активної заявки на оплату. Натисніть «Оплатити» і створіть нову."
    );
  }

  // Дістаємо file_id з фото або документа
  let fileId = null;
  if (ctx.message.photo?.length) {
    fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id; // найбільше фото
  } else if (ctx.message.document) {
    fileId = ctx.message.document.file_id;
  }
  if (!fileId) {
    return ctx.reply("Не вдалося отримати файл. Спробуйте надіслати ще раз.");
  }

  // Оновлюємо чек + статус: pending → review; якщо вже review — просто оновлюємо файл
  db.prepare(
    `
    UPDATE payments
    SET proof_file_id = ?,
        status = CASE WHEN status='pending' THEN 'review' ELSE status END
    WHERE id = ?
  `
  ).run(fileId, p.id);

  await ctx.reply("✅ Чек отримано. Заявка передана на перевірку.");

  // Повідомляємо суперадмінів
  try {
    notifySupers(
      `🔎 Заявка *review*: ${u.name} (id:${uid}), ${planName(p.plan)}, ref=${
        p.ref_code
      }`
    );
  } catch {}
});

/* ===== Меню Адміна ===== */
bot.hears("Меню Адміна", async (ctx) => {
  const u = requireRegistered(ctx);
  if (!u) return;
  if (!isAdmin(u.user_id)) return ctx.reply("Недоступно. Лише для адмінів.");

  // Базові пункти для адміна (як і було): Учасники / Історія / Очистити історію
  const rows = [
    [Markup.button.callback("Учасники", "adm:users:1")],
    [Markup.button.callback("Історія", "adm:hist")],
    [Markup.button.callback("Очистити історію", "adm:clear")],
  ];

  // Розширені пункти (видимі всім адмінам, але дія — тільки для суперадмінів)
  rows.push([Markup.button.callback("Черга оплат", "sa:q:1")]);
  rows.push([Markup.button.callback("Активні абонементи", "sa:active:1")]);
  rows.push([Markup.button.callback("Надати/Продовжити вручну", "sa:grant")]);
  rows.push([Markup.button.callback("Заблокувати/Розблокувати", "sa:block")]);
  rows.push([Markup.button.callback("Журнал дій", "sa:log:1")]);

  await ctx.reply("Меню Адміна:", Markup.inlineKeyboard(rows));
});

/* ===== Допоміжні: пагінація тексту за розміром ===== */
function splitByLimit(text, limit = TELEGRAM_SAFE_LIMIT) {
  const parts = [];
  for (let i = 0; i < text.length; i += limit) {
    parts.push(text.slice(i, i + limit));
  }
  return parts;
}

/* ===== Обробка callback'ів базових адмін-функцій ===== */
bot.on("callback_query", async (ctx, next) => {
  const data = ctx.callbackQuery.data || "";

  // --- Учасники (пагінація) ---
  function buildUsersPage(page) {
    const users = db
      .prepare(
        `
    SELECT u.user_id, u.name, u.room, u.username, u.faculty, u.registered,
           COUNT(v.session_id) AS sessions
    FROM users u
    LEFT JOIN visits v
      ON v.user_id = u.user_id AND v.exited_at IS NOT NULL
    WHERE u.registered = 1
    GROUP BY u.user_id
    ORDER BY sessions DESC, u.name ASC
  `
      )
      .all();

    const totalPages = Math.max(1, Math.ceil(users.length / USERS_PER_PAGE));
    const current = Math.min(Math.max(1, page), totalPages);
    const slice = users.slice(
      (current - 1) * USERS_PER_PAGE,
      current * USERS_PER_PAGE
    );

    const lines = slice.map((row, idx) => {
      const link = row.username ? ` @${row.username}` : "";
      return `${(current - 1) * USERS_PER_PAGE + idx + 1}. ${
        row.name
      }${link} (к.${row.room}${
        row.faculty ? `, ${row.faculty}` : ""
      }) — сесій: ${row.sessions}`;
    });

    let text =
      `Зареєстровані учасники: ${users.length}\nСторінка ${current}/${totalPages}\n\n` +
      (lines.join("\n") || "—");

    // безпечна обрізка, щоб уникнути 400
    if (text.length > TELEGRAM_SAFE_LIMIT) {
      text = text.slice(0, TELEGRAM_SAFE_LIMIT - 3) + "...";
    }

    const navRow = [];
    if (current > 1)
      navRow.push(
        Markup.button.callback("« Назад", `adm:users:${current - 1}`)
      );
    if (current < totalPages)
      navRow.push(
        Markup.button.callback("Вперед »", `adm:users:${current + 1}`)
      );

    const extra = navRow.length
      ? { reply_markup: { inline_keyboard: [navRow] } }
      : undefined;

    return { text, extra };
  }

  // Початок перегляду списку (кнопка «Учасники» у меню адміна повинна передавати adm:users:1)
  bot.action(/^adm:users:(\d+)$/, async (ctx) => {
    const me = getUser(ctx.from.id);
    if (!me || !isAdmin(me.user_id)) {
      await ctx.answerCbQuery("Лише для адмінів.", { show_alert: true });
      return;
    }

    const page = Number(ctx.match[1] || 1);
    const { text, extra } = buildUsersPage(page);

    try {
      await ctx.editMessageText(text, extra);
    } catch {
      // якщо не вийшло редагувати — шлемо новим повідомленням
      await ctx.reply(text, extra);
    }

    await ctx.answerCbQuery().catch(() => {});
  });

  // --- Історія (список дат) ---
  if (data === "adm:hist") {
    const u = getUser(ctx.from.id);
    if (!u || !isAdmin(u.user_id)) {
      await ctx.answerCbQuery("Лише для адмінів.", { show_alert: true });
      return;
    }

    const dates = db
      .prepare(
        `SELECT DISTINCT substr(started_at,1,10) AS d
         FROM sessions ORDER BY d DESC LIMIT 28`
      )
      .all();

    if (!dates.length) {
      await sendOrEdit(ctx, "Сесій поки немає.");
      return;
    }

    const buttons = dates.map((r) => [
      Markup.button.callback(r.d, `hist:${r.d}:1`),
    ]);
    await sendOrEdit(ctx, "Оберіть дату:", Markup.inlineKeyboard(buttons));
    return;
  }

  // --- Очистити історію ---
  // --- Очистити історію (Запит підтвердження) ---
    if (data === "adm:clear") {
      const u = getUser(ctx.from.id);
      if (!u || !isAdmin(u.user_id)) {
        await ctx.answerCbQuery("Лише для адмінів.", { show_alert: true });
        return;
      }

      // Запитуємо підтвердження
      const kb = Markup.inlineKeyboard([
        [Markup.button.callback("Так, очистити", "adm:clear:confirm")],
        [Markup.button.callback("Ні, скасувати", "adm:clear:cancel")],
      ]);

      await sendOrEdit(
        ctx,
        "⚠️ **Ви впевнені?**\n\nВи збираєтесь *повністю* очистити всю історію сесій та відвідувань.\n\nЦя дія незворотня.",
        {
          parse_mode: "Markdown",
          reply_markup: kb.reply_markup,
        }
      );
      await ctx.answerCbQuery().catch(() => {}); // Просто закрити спінер
      return;
    }

    // --- Очистити історію (Підтверджено) ---
    if (data === "adm:clear:confirm") {
      const u = getUser(ctx.from.id);
      if (!u || !isAdmin(u.user_id)) {
        await ctx.answerCbQuery("Лише для адмінів.", { show_alert: true });
        return;
      }
      try {
        const clearTx = db.transaction(() => {
          db.prepare(`DELETE FROM visits`).run();
          db.prepare(`DELETE FROM captain_changes`).run();
          db.prepare(`DELETE FROM sessions`).run();
        });
        clearTx();
        await sendOrEdit(ctx, "✅ Історію зала очищено (користувачі збережені).");
      } catch (e) {
        await ctx.answerCbQuery(`Помилка: ${e.message}`, { show_alert: true });
      }
      return;
    }

    // --- Очистити історію (Скасовано) ---
    if (data === "adm:clear:cancel") {
      const u = getUser(ctx.from.id);
      if (!u || !isAdmin(u.user_id)) {
        await ctx.answerCbQuery("Лише для адмінів.", { show_alert: true });
        return;
      }
      await sendOrEdit(ctx, "Дію скасовано. Історія не була очищена.");
      await ctx.answerCbQuery().catch(() => {});
      return;
    }

  // --- Історія за дату (пагінація) ---
  if (data.startsWith("hist:")) {
    const u = getUser(ctx.from.id);
    if (!u || !isAdmin(u.user_id)) {
      await ctx.answerCbQuery("Лише для адмінів.", { show_alert: true });
      return;
    }

    const [, day, pageStr] = data.split(":");
    const page = Math.max(1, parseInt(pageStr || "1", 10));

    const fromSql = `${day} 00:00:00`;
    const toSqlEnd = `${day} 23:59:59`;

    const sessions = db
      .prepare(
        `SELECT s.id, s.started_at, s.ended_at, s.captain_id
         FROM sessions s
         WHERE s.started_at BETWEEN ? AND ?
         ORDER BY s.started_at ASC`
      )
      .all(fromSql, toSqlEnd);

    if (!sessions.length) {
      await sendOrEdit(ctx, `За ${day} сесій не знайдено.`);
      return;
    }

    const blocks = [];
    let buf = `Історія за ${day}\n\n`;
    for (const s of sessions) {
      const people = db
        .prepare(
          `SELECT u.name, u.room, v.entered_at, v.exited_at
           FROM visits v JOIN users u ON u.user_id=v.user_id
           WHERE v.session_id=? ORDER BY v.entered_at`
        )
        .all(s.id);

      const changes = db
        .prepare(
          `SELECT old_captain_id, new_captain_id, changed_at
           FROM captain_changes
           WHERE session_id=? ORDER BY changed_at`
        )
        .all(s.id);

      const firstCaptain = changes[0]?.new_captain_id
        ? getNameById(changes[0].new_captain_id)
        : getNameById(s.captain_id);

      const lastCaptain = changes[changes.length - 1]?.new_captain_id
        ? getNameById(changes[changes.length - 1].new_captain_id)
        : getNameById(s.captain_id);

      const transfers =
        changes
          .filter((c) => c.old_captain_id != null)
          .map(
            (c) =>
              `  ↪ ${toLocal(c.changed_at)}: ${getNameById(
                c.old_captain_id
              )} → ${getNameById(c.new_captain_id)}`
          )
          .join("\n") || "  — передач не було —";

      const list = people.length
        ? people
            .map(
              (p) =>
                `• ${p.name} (к.${p.room}) — ${toLocal(
                  p.entered_at
                )} → ${toLocal(p.exited_at)}`
            )
            .join("\n")
        : "— нікого —";

      const block =
        [
          `#${s.id}  ${toLocal(s.started_at)} → ${toLocal(s.ended_at)}`,
          `Перший капітан: ${firstCaptain}`,
          `Останній капітан: ${lastCaptain}`,
          `Передачі:\n${transfers}`,
          `Учасники:\n${list}`,
        ].join("\n") + "\n\n";

      if ((buf + block).length > TELEGRAM_SAFE_LIMIT) {
        blocks.push(buf.trimEnd());
        buf = block;
      } else {
        buf += block;
      }
    }
    if (buf.trim()) blocks.push(buf.trimEnd());

    const totalPages = Math.max(1, blocks.length);
    const current = Math.min(page, totalPages);
    const text = `Сторінка ${current}/${totalPages}\n\n${blocks[current - 1]}`;

    const nav = [];
    if (current > 1)
      nav.push(Markup.button.callback("« Назад", `hist:${day}:${current - 1}`));
    if (current < totalPages)
      nav.push(
        Markup.button.callback("Вперед »", `hist:${day}:${current + 1}`)
      );

    await sendOrEdit(
      ctx,
      text,
      nav.length ? Markup.inlineKeyboard([nav]) : undefined
    );
    await ctx.answerCbQuery().catch(() => {});
    return;
  }

  return next();
});

/* ===== Розширені функції лише для суперадмінів ===== */

// Нотифікації суперадмінам
function notifySupers(text) {
  for (const id of SUPER_ADMINS) {
    bot.telegram
      .sendMessage(id, text, { parse_mode: "Markdown" })
      .catch(() => {});
  }
}

// Стан очікування тексту для відхилення з причиною / ручної видачі / блокування
const saRejectState = new Map(); // admin_id -> payment_id
const saGrantState = new Map(); // admin_id -> { stage: 'askUser'|'choosePlan'|'done', targetId? }
const saBlockState = new Map(); // admin_id -> asking user id

bot.on("callback_query", async (ctx, next) => {
  const data = ctx.callbackQuery.data || "";

  // --- Черга оплат (список) ---
  if (data.startsWith("sa:q:")) {
    const admin = getUser(ctx.from.id);
    if (!admin || !isAdmin(admin.user_id)) {
      await ctx.answerCbQuery("Лише для адмінів.", { show_alert: true });
      return;
    }
    if (!isSuperAdmin(admin.user_id)) {
      await ctx.answerCbQuery("Лише для суперадміністраторів.", {
        show_alert: true,
      });
      return;
    }

    const page = Math.max(1, parseInt(data.split(":")[2] || "1", 10));
    // спершу review, потім pending
    const items = db
      .prepare(
        `SELECT * FROM payments
         WHERE status IN ('review','pending')
         ORDER BY CASE status WHEN 'review' THEN 0 ELSE 1 END, created_at ASC`
      )
      .all();

    if (!items.length) {
      await sendOrEdit(ctx, "Черга порожня.");
      return;
    }

    const total = items.length;
    const current = Math.min(page, total);
    const p = items[current - 1];

    const u = getUser(p.user_id);

    const months = p.months || 1;
    const disc = p.discount_percent || 0;
    const amountDisplay =
      p.amount_uah != null
        ? `${p.amount_uah} грн`
        : `${Math.round(p.amount / 100)} грн`;

    const text =
      `Заявка ${current}/${total}\n` +
      `Користувач: ${u?.name || p.user_id} (id:${p.user_id})\n` +
      `План: ${planName(p.plan)}\n${planDescription(p.plan)}\n` +
      `Тривалість: ${months} міс.${disc ? ` (знижка ${disc}%)` : ""}\n` +
      `Сума: ${amountDisplay}\n` +
      `Статус: ${p.status}\n` +
      `ref: ${p.ref_code}\n` +
      `Створено: ${toLocal(p.created_at)}`;

    const row1 = [];
    row1.push(
      Markup.button.callback("« Назад", `sa:q:${Math.max(1, current - 1)}`)
    );
    row1.push(
      Markup.button.callback("Вперед »", `sa:q:${Math.min(total, current + 1)}`)
    );

    const row2 = [];
    row2.push(Markup.button.callback("Показати чек", `sa:proof:${p.id}`));
    row2.push(Markup.button.callback("Підтвердити", `sa:appr:${p.id}`));
    row2.push(Markup.button.callback("Відхилити", `sa:rej:${p.id}`));

    await sendOrEdit(ctx, text, Markup.inlineKeyboard([row1, row2]));
    await ctx.answerCbQuery().catch(() => {});
    return;
  }

  // --- Показати чек ---
  if (data.startsWith("sa:proof:")) {
    const admin = getUser(ctx.from.id);
    if (!admin || !isAdmin(admin.user_id)) {
      await ctx.answerCbQuery("Лише для адмінів.", { show_alert: true });
      return;
    }
    if (!isSuperAdmin(admin.user_id)) {
      await ctx.answerCbQuery("Лише для суперадміністраторів.", {
        show_alert: true,
      });
      return;
    }

    const pid = Number(data.split(":")[2]);
    const p = db.prepare(`SELECT * FROM payments WHERE id=?`).get(pid);
    if (!p) {
      await ctx.answerCbQuery("Заявку не знайдено.", { show_alert: true });
      return;
    }
    if (!p.proof_file_id) {
      await ctx.answerCbQuery("Користувач не надав чек.", { show_alert: true });
      return;
    }
    // пробуємо як фото, якщо не вийде — як документ
    try {
      await bot.telegram.sendPhoto(ctx.from.id, p.proof_file_id);
    } catch {
      try {
        await bot.telegram.sendDocument(ctx.from.id, p.proof_file_id);
      } catch {}
    }
    await ctx.answerCbQuery().catch(() => {});
    return;
  }

  // --- Підтвердити оплату ---
  if (data.startsWith("sa:appr:")) {
    const pid = Number(data.split(":")[2]);
    const p = db.prepare(`SELECT * FROM payments WHERE id=?`).get(pid);

    if (!p) {
      await ctx.answerCbQuery("Заявку не знайдено.");
      return;
    }
    if (!["pending", "review"].includes(p.status)) {
      await ctx.answerCbQuery("Непридатна заявка.");
      return;
    }

    const months = Math.max(1, p.months || 1);

    // останній період користувача
    const last = getLastSubscription(p.user_id);
    const lastEndMs = last
      ? Date.parse(last.end_at.replace(" ", "T") + "Z")
      : 0;

    // новий період: або зразу, або з кінця попереднього
    const startDate = new Date(Math.max(Date.now(), lastEndMs + 1000));
    const endDate = new Date(startDate.getTime());
    endDate.setMonth(endDate.getMonth() + months);

    const startSql = sqlFromDate(startDate);
    const endSql = sqlFromDate(endDate);
    const adminId = ctx.from.id;

    const tx = db.transaction(() => {
      // 1) оновлюємо статус платежу
      db.prepare(
        `UPDATE payments SET status='approved', approved_at=datetime('now') WHERE id=?`
      ).run(pid);

      // 2) додаємо підписку-період (ЄДИНИЙ джерело істини)
      addSubscription(p.user_id, p.plan, startSql, endSql);

      // 3) лог дії
      db.prepare(
        `INSERT INTO admin_actions (actor_id, action, target_user_id, payment_id, details)
     VALUES (?,?,?,?,?)`
      ).run(
        adminId,
        "approve_payment",
        p.user_id,
        p.id,
        `plan=${p.plan} months=${months} ${startSql}→${endSql}`
      );
    });

    try {
      tx();
    } catch (e) {
      console.error("approve_payment error:", e);
      await ctx.answerCbQuery("Помилка під час підтвердження.", {
        show_alert: true,
      });
      return;
    }

    await ctx.answerCbQuery("Підтверджено.");
    try {
      await bot.telegram.sendMessage(
        p.user_id,
        `✅ Оплату підтверджено.\n${planName(p.plan)}\n${planDescription(
          p.plan
        )}\n` +
          `Тривалість: ${months} міс.\nПеріод: ${toLocal(startSql)} → ${toLocal(
            endSql
          )}`
      );
    } catch {}
    return;
  }

  // --- Відхилити оплату (запрос причини) ---
  if (data.startsWith("sa:rej:")) {
    const admin = getUser(ctx.from.id);
    if (!admin || !isAdmin(admin.user_id)) {
      await ctx.answerCbQuery("Лише для адмінів.", { show_alert: true });
      return;
    }
    if (!isSuperAdmin(admin.user_id)) {
      await ctx.answerCbQuery("Лише для суперадміністраторів.", {
        show_alert: true,
      });
      return;
    }

    // коректний парсинг id
    const parts = data.split(":"); // ["sa","rej","<id>"]
    const pid = Number(parts[2]);

    const p = db.prepare(`SELECT * FROM payments WHERE id=?`).get(pid);
    if (!p || !["pending", "review"].includes(p.status)) {
      await ctx.answerCbQuery("Непридатна заявка.", { show_alert: true });
      return;
    }
    saRejectState.set(admin.user_id, pid);
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply(
      "Введіть причину відхилення як наступне повідомлення (текстом)."
    );
    return;
  }

  // --- Активні абонементи (лише суперадм) ---
  if (data.startsWith("sa:active:")) {
    const admin = getUser(ctx.from.id);
    if (!admin || !isAdmin(admin.user_id)) {
      await ctx.answerCbQuery("Лише для адмінів.", { show_alert: true });
      return;
    }
    if (!isSuperAdmin(admin.user_id)) {
      await ctx.answerCbQuery("Лише для суперадміністраторів.", {
        show_alert: true,
      });
      return;
    }

    const parts = data.split(":");
    const page = Math.max(1, parseInt(parts[2] || "1", 10));

    // Активні саме "зараз" періоди за subscriptions
    const rows = db
      .prepare(
        `
    SELECT s.user_id, s.plan, s.end_at,
           u.name, u.room, u.faculty, u.username
    FROM subscriptions s
    JOIN users u ON u.user_id = s.user_id
    WHERE s.start_at <= datetime('now') AND s.end_at >= datetime('now')
    ORDER BY s.end_at DESC, u.name ASC
  `
      )
      .all();

    if (!rows.length) {
      await sendOrEdit(ctx, "Зараз немає активних абонементів.");
      await ctx.answerCbQuery().catch(() => {});
      return;
    }

    const totalPages = Math.max(1, Math.ceil(rows.length / SUBS_PER_PAGE));
    const current = Math.min(page, totalPages);
    const slice = rows.slice(
      (current - 1) * SUBS_PER_PAGE,
      current * SUBS_PER_PAGE
    );

    const lines = slice.map((r, idx) => {
      const nick = r.username ? ` @${r.username}` : "";
      return `${(current - 1) * SUBS_PER_PAGE + idx + 1}. ${r.name}${nick} (к.${
        r.room
      }${r.faculty ? `, ${r.faculty}` : ""}) — ${planName(r.plan)} до ${toLocal(
        r.end_at
      )}`;
    });

    let text =
      `Активні абонементи: ${rows.length}\nСторінка ${current}/${totalPages}\n\n` +
      lines.join("\n");

    if (text.length > TELEGRAM_SAFE_LIMIT) {
      text = text.slice(0, TELEGRAM_SAFE_LIMIT - 3) + "...";
    }

    const nav = [];
    if (current > 1)
      nav.push(Markup.button.callback("« Назад", `sa:active:${current - 1}`));
    if (current < totalPages)
      nav.push(Markup.button.callback("Вперед »", `sa:active:${current + 1}`));

    await sendOrEdit(
      ctx,
      text,
      nav.length ? Markup.inlineKeyboard([nav]) : undefined
    );
    await ctx.answerCbQuery().catch(() => {});
    return;
  }

  // --- Старт ручної видачі: попросити id користувача ---
  if (data === "sa:grant") {
    const admin = getUser(ctx.from.id);
    if (!admin || !isAdmin(admin.user_id)) {
      await ctx.answerCbQuery("Лише для адмінів.", { show_alert: true });
      return;
    }
    if (!isSuperAdmin(admin.user_id)) {
      await ctx.answerCbQuery("Лише для суперадміністраторів.", {
        show_alert: true,
      });
      return;
    }
    saGrantState.set(admin.user_id, { stage: "askUser" });
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply("Введіть user_id користувача (числом).");
    return;
  }

  // --- Тогл блок/анблок: попросити id користувача ---
  if (data === "sa:block") {
    const admin = getUser(ctx.from.id);
    if (!admin || !isAdmin(admin.user_id)) {
      await ctx.answerCbQuery("Лише для адмінів.", { show_alert: true });
      return;
    }
    if (!isSuperAdmin(admin.user_id)) {
      await ctx.answerCbQuery("Лише для суперадміністраторів.", {
        show_alert: true,
      });
      return;
    }
    saBlockState.set(admin.user_id, true);
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply(
      "Введіть user_id користувача (числом) для блокування/розблокування."
    );
    return;
  }

  // --- Надати/Продовжити вручну: вибір плану і місяців ---
  if (data.startsWith("sa:grant:")) {
    // Формат: sa:grant:<uid>:<plan>
    const [, , uidStr, plan] = data.split(":");
    const targetId = Number(uidStr);

    const admin = getUser(ctx.from.id);
    if (!admin || !isAdmin(admin.user_id) || !isSuperAdmin(admin.user_id)) {
      await ctx.answerCbQuery("Лише для суперадміністраторів.", {
        show_alert: true,
      });
      return;
    }

    if (!targetId || !["A", "B", "UNL"].includes(plan)) {
      await ctx.answerCbQuery("Некоректні дані.");
      return;
    }

    const user = getUser(targetId);
    if (!user) {
      await ctx.answerCbQuery("Користувача не знайдено.", { show_alert: true });
      return;
    }
    if (!isPlanAllowedForFaculty(user.faculty, plan)) {
      await ctx.answerCbQuery("UNLIMITED недоступний для ІСЗІ.", {
        show_alert: true,
      });
      return;
    }

    const rows = [];
    for (let m = 1; m <= 9; m++) {
      rows.push([
        Markup.button.callback(
          `${m} міс.`,
          `sa:grantm:${targetId}:${plan}:${m}`
        ),
      ]);
    }
    await sendOrEdit(
      ctx,
      `Користувач: ${user.name} (к.${user.room}${
        user.faculty ? `, ${user.faculty}` : ""
      }).\n` +
        `План: ${planName(plan)}\n${planDescription(plan)}\n` +
        `Оберіть тривалість:`,
      Markup.inlineKeyboard(rows)
    );
    await ctx.answerCbQuery().catch(() => {});
    return;
  }

  if (data.startsWith("sa:grantm:")) {
    // Формат: sa:grantm:<uid>:<plan>:<months>
    const [, , uidStr, plan, monthsStr] = data.split(":");
    const targetId = Number(uidStr);
    const months = clampMonths(monthsStr);

    const admin = getUser(ctx.from.id);
    if (!admin || !isAdmin(admin.user_id) || !isSuperAdmin(admin.user_id)) {
      await ctx.answerCbQuery("Лише для суперадміністраторів.", {
        show_alert: true,
      });
      return;
    }

    const user = getUser(targetId);
    if (!user) {
      await ctx.answerCbQuery("Користувача не знайдено.", { show_alert: true });
      return;
    }
    if (!isPlanAllowedForFaculty(user.faculty, plan)) {
      await ctx.answerCbQuery("UNLIMITED недоступний для ІСЗІ.", {
        show_alert: true,
      });
      return;
    }

    const last = getLastSubscription(targetId);
    const lastEndMs = last
      ? Date.parse(last.end_at.replace(" ", "T") + "Z")
      : 0;

    const startDate = new Date(Math.max(Date.now(), lastEndMs + 1000));
    const endDate = new Date(startDate.getTime());
    endDate.setMonth(endDate.getMonth() + months);

    const startSql = sqlFromDate(startDate);
    const endSql = sqlFromDate(endDate);

    const tx = db.transaction(() => {
      // 1) тільки запис періоду в subscriptions
      addSubscription(targetId, plan, startSql, endSql);

      // 2) аудит дії
      db.prepare(
        `INSERT INTO admin_actions (actor_id, action, target_user_id, details)
     VALUES (?,?,?,?)`
      ).run(
        admin.user_id,
        "grant_manual",
        targetId,
        `plan=${plan} months=${months} ${startSql}→${endSql}`
      );
    });

    try {
      tx();
    } catch (e) {
      console.error("grant_manual months error:", e);
      await ctx.answerCbQuery("Помилка при видачі/продовженні.", {
        show_alert: true,
      });
      return;
    }

    await ctx.answerCbQuery("Готово.").catch(() => {});
    await sendOrEdit(
      ctx,
      `✅ Надано/продовжено доступ вручну.\n${planName(
        plan
      )}\n${planDescription(plan)}\n` +
        `Тривалість: ${months} міс.\nПеріод: ${toLocal(startSql)} → ${toLocal(
          endSql
        )}`
    );
    try {
      await bot.telegram.sendMessage(
        targetId,
        `✅ Вам надано/продовжено доступ вручну.\n${planName(
          plan
        )}\n${planDescription(plan)}\n` +
          `Тривалість: ${months} міс.\нПеріод: ${toLocal(startSql)} → ${toLocal(
            endSql
          )}`
      );
    } catch {}
    return;
  }
  // --- Журнал дій суперадміністраторів ---
  if (data.startsWith("sa:log:")) {
    const admin = getUser(ctx.from.id);
    if (!admin || !isAdmin(admin.user_id) || !isSuperAdmin(admin.user_id)) {
      await ctx.answerCbQuery("Лише для суперадміністраторів.", {
        show_alert: true,
      });
      return;
    }

    const LOGS_PER_PAGE = 20;
    const parts = data.split(":"); // sa:log:<page>
    const page = Math.max(1, parseInt(parts[2] || "1", 10));

    const logs = db
      .prepare(
        `
      SELECT a.id, a.actor_id, a.action, a.target_user_id, a.payment_id, a.details,
             a.created_at,
             ua.name AS actor_name,
             ut.name AS target_name
      FROM admin_actions a
      LEFT JOIN users ua ON ua.user_id = a.actor_id
      LEFT JOIN users ut ON ut.user_id = a.target_user_id
      ORDER BY a.id DESC
    `
      )
      .all();

    if (!logs.length) {
      await sendOrEdit(ctx, "Журнал порожній.");
      await ctx.answerCbQuery().catch(() => {});
      return;
    }

    const totalPages = Math.max(1, Math.ceil(logs.length / LOGS_PER_PAGE));
    const current = Math.min(page, totalPages);
    const slice = logs.slice(
      (current - 1) * LOGS_PER_PAGE,
      current * LOGS_PER_PAGE
    );

    const lines = slice.map((r, idx) => {
      const n = (current - 1) * LOGS_PER_PAGE + idx + 1;
      const when = toLocal(r.created_at);
      const actor = r.actor_name
        ? `${r.actor_name} (${r.actor_id})`
        : `${r.actor_id}`;
      const target = r.target_user_id
        ? r.target_name
          ? `${r.target_name} (${r.target_user_id})`
          : `${r.target_user_id}`
        : "—";
      const pay = r.payment_id ? `, payment_id=${r.payment_id}` : "";
      const details = r.details ? `\n   • ${r.details}` : "";
      return `${n}. ${when} — ${actor}: ${r.action} → ${target}${pay}${details}`;
    });

    let text =
      `Журнал дій (останні записи)\nСторінка ${current}/${totalPages}\n\n` +
      lines.join("\n");

    if (text.length > TELEGRAM_SAFE_LIMIT) {
      const chunks = splitByLimit(text);
      text = chunks.shift();
      for (const ch of chunks) await ctx.reply(ch);
    }

    const nav = [];
    if (current > 1)
      nav.push(Markup.button.callback("« Назад", `sa:log:${current - 1}`));
    if (current < totalPages)
      nav.push(Markup.button.callback("Вперед »", `sa:log:${current + 1}`));

    await sendOrEdit(
      ctx,
      text,
      nav.length ? Markup.inlineKeyboard([nav]) : undefined
    );
    await ctx.answerCbQuery().catch(() => {});
    return;
  }

  return next();
});

// Перехоплення тексту для суперадмінських станів (reject/ grant / block)
bot.on("text", async (ctx, next) => {
  const adminId = ctx.from.id;

  // причина відхилення
  if (saRejectState.has(adminId)) {
    const pid = saRejectState.get(adminId);
    saRejectState.delete(adminId);

    const p = db.prepare(`SELECT * FROM payments WHERE id=?`).get(pid);
    if (!p || !["pending", "review"].includes(p.status)) {
      return ctx.reply("Заявку не знайдено або її вже оброблено.");
    }

    const reason = (ctx.message.text || "Без коментаря").slice(0, 500);
    const admin = getUser(adminId);

    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE payments SET status='rejected', rejected_at=datetime('now'), comment=? WHERE id=?`
      ).run(reason, pid);
      db.prepare(
        `INSERT INTO admin_actions (actor_id, action, target_user_id, payment_id, details)
         VALUES (?,?,?,?,?)`
      ).run(admin.user_id, "reject_payment", p.user_id, p.id, reason);
    });
    tx();

    try {
      await bot.telegram.sendMessage(
        p.user_id,
        `❌ Оплату відхилено: ${reason}`
      );
    } catch {}

    return ctx.reply("Відхилено. Користувача повідомлено.");
  }

  // ручне надання/продовження (ввід user_id)
  if (saGrantState.has(adminId)) {
    const st = saGrantState.get(adminId);
    if (st.stage === "askUser") {
      const target = parseInt((ctx.message.text || "").trim(), 10);
      if (!Number.isFinite(target)) {
        return ctx.reply("Очікувався user_id (числом). Спробуйте ще раз.");
      }
      const user = getUser(target);
      if (!user) {
        return ctx.reply("Користувача з таким ID не знайдено.");
      }
      // вибір плану з урахуванням факультету
      const rows = [
        [Markup.button.callback("1 План", `sa:grant:${target}:A`)],
        [Markup.button.callback("2 План", `sa:grant:${target}:B`)],
      ];
      if (isPlanAllowedForFaculty(user.faculty, "UNL")) {
        rows.push([
          Markup.button.callback("UNLIMITED", `sa:grant:${target}:UNL`),
        ]);
      }
      saGrantState.set(adminId, { stage: "choosePlan", targetId: target });
      return ctx.reply(
        `Користувач: ${user.name} (к.${user.room}${
          user.faculty ? `, ${user.faculty}` : ""
        }). Оберіть план:`,
        Markup.inlineKeyboard(rows)
      );
    }
  }

  // блок/розблок
  if (saBlockState.has(adminId)) {
    saBlockState.delete(adminId);
    const target = parseInt((ctx.message.text || "").trim(), 10);
    if (!Number.isFinite(target)) {
      return ctx.reply("Очікувався user_id (числом). Спробуйте ще раз.");
    }
    const user = getUser(target);
    if (!user) return ctx.reply("Користувача не знайдено.");

    const newBlocked = user.blocked ? 0 : 1;
    db.prepare(`UPDATE users SET blocked=? WHERE user_id=?`).run(
      newBlocked,
      target
    );

    db.prepare(
      `INSERT INTO admin_actions (actor_id, action, target_user_id, details)
       VALUES (?,?,?,?)`
    ).run(adminId, newBlocked ? "block_user" : "unblock_user", target, "");

    try {
      await bot.telegram.sendMessage(
        target,
        newBlocked
          ? "⛔ Ваш доступ заблоковано адміністраторами."
          : "✅ Ваш доступ розблоковано адміністраторами."
      );
    } catch {}

    return ctx.reply(
      newBlocked ? "Користувача заблоковано." : "Користувача розблоковано."
    );
  }

  return next();
});

/* ===== Кнопки залу: Статус / Почати / Увійти / Вийти / Передати капітана ===== */

function requireNotBlocked(u, ctx) {
  if (u.blocked) {
    ctx.reply("⛔ Ваш доступ заблоковано адміністраторами.");
    return false;
  }
  return true;
}

function requirePaidGate(u, ctx) {
  const curSub = getCurrentSubscription(u.user_id);
  if (!curSub) {
    ctx.reply(
      "У вас немає активного абонемента. Спочатку натисніть «Оплатити»."
    );
    return false;
  }
  const activePlan = curSub.plan;
  if (!isAllowedToday(activePlan)) {
    ctx.reply(
      `За вашим планом відвідування доступне у дні: ${daysTextForPlan(
        activePlan
      )}.`
    );
    return false;
  }
  return true;
}

// Статус
bot.hears("Статус", async (ctx) => {
  const u = requireRegistered(ctx);
  if (!u) return;

  const s = getActiveSession();
  if (!s)
    return ctx.reply(
      "Зараз немає активної сесії.",
      mainKeyboard(u.user_id, null, false)
    );

  const part = listParticipants(s.id);
  const captainName = getNameById(s.captain_id);
  await ctx.reply(
    `Активна сесія\nКапітан: ${captainName}\nВсередині: ${part.length}`,
    mainKeyboard(u.user_id, s, !!getOpenVisit(s.id, u.user_id))
  );
});

// ✅ Вахта: включить/выключить уведомления
bot.hears("👮 Встати на вахту", (ctx) => {
  const uid = ctx.from.id;
  if (!WATCHER_ALLOW.has(Number(uid))) {
    return ctx.reply("⛔ Ця опція недоступна для вашого облікового запису.");
  }
  setWatcher(uid, true);
  const s = getActiveSession();
  const inside = s ? !!getOpenVisit(s.id, uid) : false;
  ctx.reply(
    "✅ Ви стали на вахту. Будете отримувати сповіщення про старт/завершення сесій.",
    mainKeyboard(uid, s, inside)
  );
});

bot.hears("❌ Вийти з вахти", (ctx) => {
  const uid = ctx.from.id;
  if (!WATCHER_ALLOW.has(Number(uid))) {
    return ctx.reply("⛔ Ця опція недоступна для вашого облікового запису.");
  }
  setWatcher(uid, false);
  const s = getActiveSession();
  const inside = s ? !!getOpenVisit(s.id, uid) : false;
  ctx.reply(
    "👋 Ви вийшли з вахти. Сповіщення більше не надходитимуть.",
    mainKeyboard(uid, s, inside)
  );
});

// --- Почати сесію (надійна версія з явними timestamp та lastInsertRowid)
bot.hears("Почати сесію", async (ctx) => {
  const u = requireRegistered(ctx);
  if (!u) return;
  if (!requireNotBlocked(u, ctx)) return;
  if (!requirePaidGate(u, ctx)) return;

  try {
    const now = new Date();
    const hourKyiv = Number(
      new Intl.DateTimeFormat("uk-UA", {
        hour: "2-digit",
        hour12: false,
        timeZone: TZ, // TZ уже определён как 'Europe/Kyiv'
      }).format(now)
    );

    if (hourKyiv >= 23 || hourKyiv < 6) {
      return ctx.reply("Старт сесії дозволено лише з 06:00, та до 23:00");
    }
  } catch (_) {
    // fallback на UTC+2/UTC+3 не нужен, TZ есть; при ошибке можно перестраховаться:
    // return ctx.reply('Тимчасово неможливо стартувати сесію. Спробуйте пізніше.');
  }

  const existing = getActiveSession();
  if (existing) {
    const inside = !!getOpenVisit(existing.id, u.user_id);
    return ctx.reply(
      "Сесія вже активна.",
      mainKeyboard(u.user_id, existing, inside)
    );
  }

  let newSession = null;
  try {
    const createTx = db.transaction((user_id) => {
      // Подвійна перевірка всередині транзакції
      const act = db.prepare(`SELECT id FROM sessions WHERE active=1`).get();
      if (act) throw new Error("ALREADY_ACTIVE");

      db.prepare(
        `INSERT INTO sessions (captain_id, started_at, active)
VALUES (?, datetime('now'), 1)`
      ).run(user_id);

      const rowid = db.prepare(`SELECT last_insert_rowid() AS id`).get().id;

      db.prepare(
        `INSERT INTO visits (session_id, user_id, entered_at)
VALUES (?, ?, datetime('now'))`
      ).run(rowid, user_id);

      db.prepare(
        `INSERT INTO captain_changes (session_id, old_captain_id, new_captain_id, changed_at)
VALUES (?, ?, ?, datetime('now'))`
      ).run(rowid, null, user_id);

      const s = db.prepare(`SELECT * FROM sessions WHERE id=?`).get(rowid);
      return s;
    });

    newSession = createTx(u.user_id);
  } catch (e) {
    if (e && e.message === "ALREADY_ACTIVE") {
      const s = getActiveSession();
      const inside = s ? !!getOpenVisit(s.id, u.user_id) : false;
      return ctx.reply(
        "Сесію вже хтось розпочав щойно.",
        mainKeyboard(u.user_id, s, inside)
      );
    }
    console.error("start_session error:", e);
    const s = getActiveSession();
    const inside = s ? !!getOpenVisit(s.id, u.user_id) : false;
    return ctx.reply(
      "Не вдалося почати сесію. Повторіть, будь ласка.",
      mainKeyboard(u.user_id, s, inside)
    );
  }

  // беремо фактичний час старту з БД (або now як fallback)
  const startedAt = newSession?.started_at || nowSql();
  try {
    await notifyWatchers(
      [
        "🔓 <b>Сесію розпочато</b>",
        `Капітан: ${esc(u.name)} (к.${esc(u.room || "—")})`,
        `Час: ${toLocal(startedAt)}`,
      ].join("\n")
    );
  } catch (e) {
    console.error("notifyWatchers start error:", e?.message || e);
  }

  if (GROUP_CHAT_ID) {
    updateStatusPost(bot, GROUP_CHAT_ID).catch(() => {});
  }

  // Ключове повідомлення користувачу
  return ctx.reply(
    "Сесію розпочато. Ви — капітан.",
    mainKeyboard(u.user_id, newSession, true)
  );
});

// Увійти
bot.hears("Увійти", async (ctx) => {
  const u = requireRegistered(ctx);
  if (!u) return;
  if (!requireNotBlocked(u, ctx)) return;
  if (!requirePaidGate(u, ctx)) return;

  const s = getActiveSession();
  if (!s)
    return ctx.reply("Сесії немає.", mainKeyboard(u.user_id, null, false));

  if (getOpenVisit(s.id, u.user_id))
    return ctx.reply("Ви вже всередині.", mainKeyboard(u.user_id, s, true));

  const had = db
    .prepare(`SELECT 1 FROM visits WHERE session_id=? AND user_id=?`)
    .get(s.id, u.user_id);

  try {
    db.prepare(
      `INSERT INTO visits (session_id, user_id, entered_at)
   VALUES (?, ?, datetime('now'))`
    ).run(s.id, u.user_id);
  } catch (e) {
    console.error("Enter error:", e.message);
    return ctx.reply("Не вдалося увійти.", mainKeyboard(u.user_id, s, false));
  }

  if (GROUP_CHAT_ID) await updateStatusPost(bot, GROUP_CHAT_ID).catch(() => {});
  const cntAfter = countParticipants(s.id);
  await notifyCaptain(
    s,
    `🟢 ${u.name} увійшов(ла). Зараз у залі: ${cntAfter}.`,
    u.user_id
  );
  return ctx.reply("Позначено: увійшли.", mainKeyboard(u.user_id, s, true));
});

// Вийти
bot.hears("Вийти", async (ctx) => {
  const u = requireRegistered(ctx);
  if (!u) return;
  if (!requireNotBlocked(u, ctx)) return;

  const s = getActiveSession();
  if (!s)
    return ctx.reply("Сесії немає.", mainKeyboard(u.user_id, null, false));

  const open = getOpenVisit(s.id, u.user_id);
  if (!open)
    return ctx.reply("Ви й так зовні.", mainKeyboard(u.user_id, s, false));

  if (s.captain_id === u.user_id) {
    const count = countParticipants(s.id);
    if (count > 1) {
      const ik = Markup.inlineKeyboard([
        [Markup.button.callback("Передати капітана", "cap:transfer")],
        [Markup.button.callback("Зрозуміло", "cap:alert")],
      ]);
      return ctx.reply(
        `⚠️ Ви — капітан. Всередині ще ${
          count - 1
        } люд(ей). Спочатку *передайте капітана*.`,
        { parse_mode: "Markdown", ...ik }
      );
    }
    db.prepare(
      `UPDATE visits
   SET exited_at = datetime('now')
   WHERE id = (
     SELECT id FROM visits
     WHERE session_id=? AND user_id=? AND exited_at IS NULL
     ORDER BY entered_at DESC
     LIMIT 1
   )`
    ).run(s.id, u.user_id);
    db.prepare(
      `UPDATE sessions SET ended_at=datetime('now'), active=0 WHERE id=?`
    ).run(s.id);
    // [WATCHERS] завершение сессии
    // Нотифікації/оновлення — вже після створення, поза транзакцією
    // [WATCHERS] завершення сесії
    const endedAt = nowSql();
    try {
      await notifyWatchers(
        [
          "🔒 <b>Сесію завершено</b>",
          `Капітан: ${esc(u.name)} (к.${esc(u.room || "—")})`,
          `Початок: ${toLocal(s.started_at)}`,
          `Кінець: ${toLocal(endedAt)}`,
        ].join("\n")
      );
    } catch (e) {
      console.error("notifyWatchers end error:", e?.message || e);
    }

    return ctx.reply(
      "Сесію завершено. Двері зачинено.",
      mainKeyboard(u.user_id, null, false)
    );
  }

  db.prepare(
    `UPDATE visits
   SET exited_at = datetime('now')
   WHERE id = (
     SELECT id FROM visits
     WHERE session_id=? AND user_id=? AND exited_at IS NULL
     ORDER BY entered_at DESC
     LIMIT 1
   )`
  ).run(s.id, u.user_id);
  if (GROUP_CHAT_ID) await updateStatusPost(bot, GROUP_CHAT_ID).catch(() => {});
  const cntAfter = countParticipants(s.id);
  await notifyCaptain(
    s,
    `🔴 ${u.name} вийшов(ла). Залишилось: ${cntAfter}.`,
    u.user_id
  );

  return ctx.reply("Позначено: вийшли.", mainKeyboard(u.user_id, s, false));
});

// Передати капітана
async function handleTransfer(ctx) {
  const u = requireRegistered(ctx);
  if (!u) return;

  const s = getActiveSession();
  if (!s)
    return ctx.reply("Сесії немає.", mainKeyboard(u.user_id, null, false));
  if (s.captain_id !== u.user_id)
    return ctx.reply(
      "Лише капітан може це зробити.",
      mainKeyboard(u.user_id, s, true)
    );

  const people = listParticipants(s.id).filter((p) => p.user_id !== u.user_id);
  if (!people.length)
    return ctx.reply(
      "Нікому передати капітана — ви один у залі.",
      mainKeyboard(u.user_id, s, true)
    );

  const buttons = people.map((p) => [
    Markup.button.callback(p.name, `xfer:${p.user_id}`),
  ]);
  return ctx.reply("Кому передати капітана?", Markup.inlineKeyboard(buttons));
}
bot.hears("Передати капітана", handleTransfer);

// Додаткові callback'и капітану
bot.on("callback_query", async (ctx, next) => {
  const data = ctx.callbackQuery.data || "";

  if (data === "cap:alert") {
    await ctx.answerCbQuery(
      "Ви — капітан. Поки всередині інші — вийти не можна. Спочатку передайте капітана.",
      { show_alert: true }
    );
    return;
  }
  if (data === "cap:transfer") {
    await handleTransfer(ctx);
    await ctx.answerCbQuery();
    return;
  }
  if (data.startsWith("xfer:")) {
    const targetId = Number(data.split(":")[1]);
    const s = getActiveSession();
    if (!s) return ctx.answerCbQuery("Сесії немає.");

    const user_id = ctx.from.id;
    if (s.captain_id !== user_id)
      return ctx.answerCbQuery("Лише чинний капітан.");

    const targetInside = getOpenVisit(s.id, targetId);
    if (!targetInside) return ctx.answerCbQuery("Ця людина вже не в залі.");

    db.prepare(
      `INSERT INTO captain_changes (session_id, old_captain_id, new_captain_id)
       VALUES (?,?,?)`
    ).run(s.id, s.captain_id, targetId);
    db.prepare(`UPDATE sessions SET captain_id=? WHERE id=?`).run(
      targetId,
      s.id
    );

    // ЛС новому капітану
    try {
      const updated = getActiveSession();
      const inside = !!getOpenVisit(updated.id, targetId);
      const cnt = countParticipants(updated.id);
      await bot.telegram.sendMessage(
        targetId,
        `👑 Вам передали капітанство.\nЗараз всередині: ${
          cnt - 1
        } інших(а).\nНе забудьте передати капітана перед виходом.`,
        mainKeyboard(targetId, updated, inside)
      );
    } catch {}

    await ctx.answerCbQuery("Капітана передано.");
    if (GROUP_CHAT_ID)
      await updateStatusPost(bot, GROUP_CHAT_ID).catch(() => {});
    return;
  }

  return next();
});

/* ===== Запуск ===== */
bot
  .launch()
  .then(() => console.log("Bot started"))
  .catch(console.error);

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

