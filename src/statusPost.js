// statusPost.js
import db from "./db.js";
import { formatInTimeZone } from "date-fns-tz";

const TZ = process.env.TZ || "Europe/Kyiv";
const SAFE_LIMIT = 3500; // запас до 4096, врахуємо ще службовий текст

// "YYYY-MM-DD HH:MM:SS" (UTC) -> локальний текст
const toLocal = (s) =>
  s
    ? formatInTimeZone(
        new Date(s.replace(" ", "T") + "Z"),
        TZ,
        "yyyy-MM-dd HH:mm"
      )
    : "—";

function clampParticipantsText(participants) {
  if (!participants?.length) return "— нікого —";
  const lines = participants.map((p) => `• ${p.name} (к.${p.room})`);
  // груба оцінка довжини (без Markdown-символів)
  let text = "";
  let count = 0;
  for (const line of lines) {
    if ((text + line + "\n").length > SAFE_LIMIT) break;
    text += line + "\n";
    count++;
  }
  const rest = lines.length - count;
  if (rest > 0) text += `… та ще ${rest}`;
  return text.trimEnd();
}

function buildStatusText({ session, participants }) {
  const list = clampParticipantsText(participants);
  const captainName = session?.captain_name || "—";
  const started = session?.started_at ? toLocal(session.started_at) : "—";
  const count = participants.length;

  return [
    "*🏋️‍♂️ Статус залу*",
    `*Капітан:* ${captainName}`,
    `*Старт:* ${started}`,
    `*Зараз всередині (${count}):*`,
    list,
  ].join("\n");
}

async function sendOrEdit(bot, chatId, messageId, text) {
  const common = { parse_mode: "Markdown", disable_web_page_preview: true };
  if (chatId && messageId) {
    try {
      await bot.telegram.editMessageText(
        chatId,
        messageId,
        undefined,
        text,
        common
      );
      return { chatId, messageId, edited: true };
    } catch (e) {
      console.warn(
        "editMessageText failed, will send new:",
        e?.description || e
      );
      // впадемо в надсилання нового
    }
  }
  const msg = await bot.telegram.sendMessage(chatId, text, common);
  try {
    await bot.telegram.pinChatMessage(chatId, msg.message_id);
  } catch (e) {
    console.warn("pinChatMessage failed:", e?.description || e);
  }
  return { chatId, messageId: msg.message_id, edited: false };
}

export async function updateStatusPost(bot, groupChatId) {
  try {
    // 1) Читаємо активну сесію
    const s = db.prepare(`SELECT * FROM sessions WHERE active = 1`).get();

    // 2) Учасники
    const participants = s
      ? db
          .prepare(
            `
            SELECT u.name, u.room
            FROM visits v
            JOIN users u ON u.user_id = v.user_id
            WHERE v.session_id = ? AND v.exited_at IS NULL
            ORDER BY u.name
          `
          )
          .all(s.id)
      : [];

    // 3) Готуємо captain_name
    const sessionData = s
      ? {
          ...s,
          captain_name:
            db
              .prepare(`SELECT name FROM users WHERE user_id = ?`)
              .get(s.captain_id)?.name || "—",
        }
      : null;

    const text = buildStatusText({ session: sessionData, participants });

    if (s) {
      // Є активна — редагуємо її статус або створюємо новий
      const res = await sendOrEdit(
        bot,
        groupChatId,
        s.status_message_id ? s.status_message_id : null,
        text
      );
      // Збережемо message_id (на випадок, якщо створили новий)
      if (!res.edited && res.messageId) {
        db.prepare(
          `UPDATE sessions SET status_chat_id = ?, status_message_id = ? WHERE id = ?`
        ).run(res.chatId, res.messageId, s.id);
      }
      return;
    }

    // Немає активної: спробуємо знайти ОСТАННЄ статус-повідомлення (з попередньої сесії) і редагувати його
    const last = db
      .prepare(
        `SELECT status_chat_id, status_message_id
         FROM sessions
         WHERE status_chat_id IS NOT NULL AND status_message_id IS NOT NULL
         ORDER BY id DESC LIMIT 1`
      )
      .get();

    if (last) {
      await sendOrEdit(bot, last.status_chat_id, last.status_message_id, text);
      return;
    }

    // Якщо редагувати нема що — просто відправимо нове (без запису в БД, бо сесії нема)
    await sendOrEdit(bot, groupChatId, null, text);
  } catch (e) {
    console.error("updateStatusPost error:", e);
    throw e; // хай викликаючий код теж побачить помилку у логах
  }
}
