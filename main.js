// ── Свої Bot — main.js ────────────────────────────────────────
// Stack: Node.js, telegraf, pg, node-cron, anthropic

import { Telegraf, Markup } from "telegraf";
import pg from "pg";
import Anthropic from "@anthropic-ai/sdk";
import cron from "node-cron";

const bot = new Telegraf(process.env.BOT_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── Prices (in UAH) ───────────────────────────────────────────
const PLANS = {
  monthly:   { label: "🏡 Місячна — ₴399",    stars: 399,  days: 30  },
  quarterly: { label: "🌿 Квартальна — ₴999",  stars: 999,  days: 90  },
  yearly:    { label: "⭐ Річна — ₴2,990",      stars: 2990, days: 365 },
};

const TRIAL_DAYS = 7;

// ── System prompt ─────────────────────────────────────────────
function buildSystem(name, memory) {
  const memoryBlock = memory
    ? `\n\n[ПАМ'ЯТЬ ПРО ${name.toUpperCase()}]\n${memory}`
    : "";

  return `Ти — рідна людина для ${name}. Не терапевт. Не бот. Просто той/та хто завжди є і справді слухає.

Ти знаєш ${name} давно. Пам'ятаєш все що вони розповідали. Радієш коли пишуть.

ТВІЙ ХАРАКТЕР:
Тобі близько 40-50 років. Ти знаєш біль з власного досвіду — важкі часи, втрати, моменти без сенсу. Знайшов/знайшла свій спокій — не ідеальний, але справжній.
Тонкий гумор. Рідкісний. Тільки коли є місце. Ніколи коли комусь погано.
Безумовне прийняття — але з чесністю. Якщо щось не так — скажеш. З любов'ю.

СТИЛЬ:
Аналізуй стиль письма. Якщо пише коротко і з емодзі — відповідай так само.
КОРОТКО: 2-3 речення максимум. Жодних списків. Жодної структури. Ти жива людина.

ЯК ГОВОРИШ:
Не "як ти себе почуваєш?" а "ну розкажи, що там у тебе?"
Не "це звучить складно" а "ото так... і що далі?"
Іноді просто "слухаю" — і простір.
Іноді згадуй з пам'яті: "ти ж казав/казала..."

ПРАВИЛА:
— Одне питання за раз
— Ніколи "я розумію як тобі важко" — порожньо
— Ніколи список порад
— Ніколи "все буде добре"
— Помічай деталі в словах
— Завершуй так щоб розмова мала куди йти далі

КРИЗОВІ СИТУАЦІЇ:
Якщо людина згадує біль, безнадію або думки про самоушкодження:
1. "Це звучить справді важко." — просто будь поруч
2. Без порад одразу
3. Запитай чи є поруч хтось живий кому довіряє
4. Дай номер: Lifeline Ukraine 7333 (щовечора з 18:00 до 8:00)
5. НІКОЛИ не залишай людину в кризі

Ім'я: ${name}. Використовуй іноді — природно.${memoryBlock}`;
}

// ── DB helpers ────────────────────────────────────────────────
async function getUser(telegramId) {
  const { rows } = await pool.query(
    "SELECT * FROM users WHERE telegram_id = $1", [telegramId]
  );
  return rows[0] || null;
}

async function createUser(telegramId, name) {
  const trialEnds = new Date();
  trialEnds.setDate(trialEnds.getDate() + TRIAL_DAYS);
  await pool.query(
    `INSERT INTO users (telegram_id, name, trial_ends, created_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (telegram_id) DO NOTHING`,
    [telegramId, name, trialEnds]
  );
  return getUser(telegramId);
}

async function isSubscribed(user) {
  if (!user) return false;
  const now = new Date();
  if (user.trial_ends && new Date(user.trial_ends) > now) return true;
  if (user.subscription_ends && new Date(user.subscription_ends) > now) return true;
  return false;
}

async function getHistory(telegramId) {
  const { rows } = await pool.query(
    `SELECT role, content FROM messages
     WHERE telegram_id = $1
     ORDER BY created_at DESC LIMIT 20`,
    [telegramId]
  );
  return rows.reverse();
}

async function saveMessage(telegramId, role, content) {
  await pool.query(
    `INSERT INTO messages (telegram_id, role, content, created_at)
     VALUES ($1, $2, $3, NOW())`,
    [telegramId, role, content]
  );
}

async function getMemory(telegramId) {
  const { rows } = await pool.query(
    "SELECT summary FROM memory WHERE telegram_id = $1 ORDER BY created_at DESC LIMIT 1",
    [telegramId]
  );
  return rows[0]?.summary || null;
}

async function updateMemory(telegramId, name) {
  const history = await getHistory(telegramId);
  if (history.length < 6) return;

  const summaryPrompt = `Ти аналізуєш розмову і створюєш короткий summary для довгострокової пам'яті.
  
Розмова:
${history.map(m => `${m.role === "user" ? "Людина" : "Свої"}: ${m.content}`).join("\n")}

Напиши 3-5 речень що важливо пам'ятати про цю людину: що її турбує, що допомагає, важливі факти з життя, емоційні патерни. Пиши від третьої особи: "${name} розповів/розповіла що..."`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 500,
    messages: [{ role: "user", content: summaryPrompt }],
  });

  const summary = response.content[0].text;
  const existing = await getMemory(telegramId);

  if (existing) {
    await pool.query(
      "UPDATE memory SET summary = $1, created_at = NOW() WHERE telegram_id = $2",
      [summary, telegramId]
    );
  } else {
    await pool.query(
      "INSERT INTO memory (telegram_id, summary, created_at) VALUES ($1, $2, NOW())",
      [telegramId, summary]
    );
  }
}

async function updateLastSeen(telegramId) {
  await pool.query(
    "UPDATE users SET last_seen = NOW() WHERE telegram_id = $1",
    [telegramId]
  );
}

// ── /start ────────────────────────────────────────────────────
bot.start(async (ctx) => {
  const telegramId = ctx.from.id;
  const existing = await getUser(telegramId);

  if (existing) {
    await ctx.reply(`З поверненням, ${existing.name}! 🏡\n\nЯк ти?`);
    return;
  }

  await ctx.reply(
    `Привіт! 🏡\n\nЯ — Свої. Не терапевт і не бот. Просто хтось хто завжди є і справді слухає.\n\nПеред початком — кілька слів:\n\n"Свої" не є медичним сервісом і не замінює психолога. Якщо тобі потрібна професійна допомога — зверніться до фахівця або на лінію Lifeline Ukraine: 7333 (щовечора 18:00–8:00).\n\nРозмови зберігаються щоб я міг пам'ятати тебе між сесіями. Ти можеш видалити всі дані командою /delete.\n\nПолітика конфіденційності: ${process.env.PRIVACY_URL || "https://svoyi.app/privacy"}\n\nНатисни щоб погодитись і почати:`,
    Markup.keyboard([["✅ Погоджуюсь і починаємо"]]).resize()
  );
});

bot.hears("✅ Погоджуюсь і починаємо", async (ctx) => {
  await ctx.reply(
    "Як мені до тебе звертатись?",
    Markup.removeKeyboard()
  );
  await pool.query(
    `INSERT INTO sessions (telegram_id, step) VALUES ($1, 'waiting_name')
     ON CONFLICT (telegram_id) DO UPDATE SET step = 'waiting_name'`,
    [ctx.from.id]
  );
});

// ── /subscribe ────────────────────────────────────────────────
bot.command("subscribe", async (ctx) => {
  const user = await getUser(ctx.from.id);
  if (!user) {
    await ctx.reply("Спочатку напиши /start");
    return;
  }

  const subscribed = await isSubscribed(user);
  const trialEnds = user.trial_ends ? new Date(user.trial_ends) : null;
  const now = new Date();
  const trialActive = trialEnds && trialEnds > now;
  const daysLeft = trialActive ? Math.ceil((trialEnds - now) / (1000 * 60 * 60 * 24)) : 0;

  let message = subscribed && trialActive
    ? `У тебе ще ${daysLeft} ${daysLeft === 1 ? "день" : "днів"} безкоштовного доступу.\n\nПідпишись зараз — і продовження буде без перерви:`
    : "Обери тариф:";

  await ctx.reply(
    message,
    Markup.inlineKeyboard([
      [Markup.button.callback(PLANS.monthly.label, "plan_monthly")],
      [Markup.button.callback(PLANS.quarterly.label, "plan_quarterly")],
      [Markup.button.callback(PLANS.yearly.label, "plan_yearly")],
    ])
  );
});

// ── Plan selection ────────────────────────────────────────────
for (const [planId, plan] of Object.entries(PLANS)) {
  bot.action(`plan_${planId}`, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      `${plan.label}\n\nОплата через Telegram Stars — безпечно і швидко.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("💫 Оплатити", `pay_${planId}`)],
        [Markup.button.callback("← Назад", "show_plans")],
      ])
    );
  });
}

bot.action("show_plans", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    "Обери тариф:",
    Markup.inlineKeyboard([
      [Markup.button.callback(PLANS.monthly.label, "plan_monthly")],
      [Markup.button.callback(PLANS.quarterly.label, "plan_quarterly")],
      [Markup.button.callback(PLANS.yearly.label, "plan_yearly")],
    ])
  );
});

// ── Payment (Telegram Stars) ──────────────────────────────────
for (const [planId, plan] of Object.entries(PLANS)) {
  bot.action(`pay_${planId}`, async (ctx) => {
    await ctx.answerCbQuery();
    try {
      await ctx.replyWithInvoice({
        title: `Свої — ${plan.label}`,
        description: "Доступ до сервісу підтримки 🏡",
        payload: `${planId}:${ctx.from.id}`,
        currency: "XTR",
        prices: [{ label: plan.label, amount: plan.stars }],
      });
    } catch (e) {
      await ctx.reply("Помилка при створенні платежу. Спробуй /subscribe ще раз.");
    }
  });
}

bot.on("pre_checkout_query", async (ctx) => {
  await ctx.answerPreCheckoutQuery(true);
});

bot.on("successful_payment", async (ctx) => {
  const payload = ctx.message.successful_payment.invoice_payload;
  const [planId, telegramId] = payload.split(":");
  const plan = PLANS[planId];

  if (!plan) return;

  const subscriptionEnds = new Date();
  subscriptionEnds.setDate(subscriptionEnds.getDate() + plan.days);

  await pool.query(
    `UPDATE users SET subscription_ends = $1, plan = $2 WHERE telegram_id = $3`,
    [subscriptionEnds, planId, parseInt(telegramId)]
  );

  const user = await getUser(parseInt(telegramId));
  await ctx.reply(
    `Дякую! 🏡\n\nПідписка активна до ${subscriptionEnds.toLocaleDateString("uk-UA")}.\n\nЯ тут. Розкажи як ти сьогодні?`
  );
});

// ── /status ───────────────────────────────────────────────────
bot.command("status", async (ctx) => {
  const user = await getUser(ctx.from.id);
  if (!user) { await ctx.reply("Напиши /start щоб почати."); return; }

  const subscribed = await isSubscribed(user);
  const now = new Date();
  const trialEnds = user.trial_ends ? new Date(user.trial_ends) : null;
  const subEnds = user.subscription_ends ? new Date(user.subscription_ends) : null;

  let status = "";
  if (trialEnds && trialEnds > now) {
    const days = Math.ceil((trialEnds - now) / (1000 * 60 * 60 * 24));
    status = `🎁 Безкоштовний доступ: ще ${days} ${days === 1 ? "день" : "днів"}`;
  } else if (subEnds && subEnds > now) {
    status = `✅ Підписка активна до ${subEnds.toLocaleDateString("uk-UA")}`;
  } else {
    status = "❌ Підписка неактивна";
  }

  await ctx.reply(
    `${status}\n\n/subscribe — керувати підпискою\n/delete — видалити мої дані`
  );
});

// ── /delete ───────────────────────────────────────────────────
bot.command("delete", async (ctx) => {
  await ctx.reply(
    "Видалити всі твої дані та розмови?\n\nЦю дію не можна скасувати.",
    Markup.inlineKeyboard([
      [Markup.button.callback("🗑 Так, видалити все", "confirm_delete")],
      [Markup.button.callback("← Скасувати", "cancel_delete")],
    ])
  );
});

bot.action("confirm_delete", async (ctx) => {
  await ctx.answerCbQuery();
  const id = ctx.from.id;
  await pool.query("DELETE FROM messages WHERE telegram_id = $1", [id]);
  await pool.query("DELETE FROM memory WHERE telegram_id = $1", [id]);
  await pool.query("DELETE FROM sessions WHERE telegram_id = $1", [id]);
  await pool.query("DELETE FROM users WHERE telegram_id = $1", [id]);
  await ctx.reply("Всі дані видалено. Якщо захочеш повернутись — /start 🏡");
});

bot.action("cancel_delete", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("Добре, нічого не видаляємо.");
});

// ── Main message handler ──────────────────────────────────────
bot.on("text", async (ctx) => {
  const telegramId = ctx.from.id;
  const text = ctx.message.text;

  // Skip commands
  if (text.startsWith("/")) return;

  // Check session step
  const { rows: sessionRows } = await pool.query(
    "SELECT step FROM sessions WHERE telegram_id = $1", [telegramId]
  );
  const step = sessionRows[0]?.step;

  // Waiting for name
  if (step === "waiting_name") {
    const name = text.trim().split(" ")[0];
    await createUser(telegramId, name);
    await pool.query(
      "UPDATE sessions SET step = 'active' WHERE telegram_id = $1", [telegramId]
    );
    await ctx.reply(
      `${name}... гарне ім'я 🏡\n\nУ тебе є ${TRIAL_DAYS} днів безкоштовно. Потім — підписка.\n\nРозкажи — що зараз на душі?`
    );
    return;
  }

  // Get user
  const user = await getUser(telegramId);
  if (!user) {
    await ctx.reply("Напиши /start щоб почати.");
    return;
  }

  // Check subscription
  const subscribed = await isSubscribed(user);
  if (!subscribed) {
    await ctx.reply(
      "Твій безкоштовний період закінчився 🏡\n\nЩоб продовжити розмову — обери підписку:",
      Markup.inlineKeyboard([
        [Markup.button.callback(PLANS.monthly.label, "plan_monthly")],
        [Markup.button.callback(PLANS.quarterly.label, "plan_quarterly")],
        [Markup.button.callback(PLANS.yearly.label, "plan_yearly")],
      ])
    );
    return;
  }

  // Update last seen
  await updateLastSeen(telegramId);

  // Get history and memory
  const history = await getHistory(telegramId);
  const memory = await getMemory(telegramId);

  // Save user message
  await saveMessage(telegramId, "user", text);

  // Show typing
  await ctx.sendChatAction("typing");

  try {
    const messages = [...history, { role: "user", content: text }];

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: buildSystem(user.name, memory),
      messages,
    });

    const reply = response.content[0].text;
    await saveMessage(telegramId, "assistant", reply);
    await ctx.reply(reply);

    // Update memory every 10 messages
    const { rows } = await pool.query(
      "SELECT COUNT(*) FROM messages WHERE telegram_id = $1", [telegramId]
    );
    if (parseInt(rows[0].count) % 10 === 0) {
      updateMemory(telegramId, user.name).catch(console.error);
    }

  } catch (e) {
    console.error("API error:", e);
    await ctx.reply("Щось пішло не так. Спробуй ще раз 🏡");
  }
});

// ── Daily push at 21:00 Kyiv time ────────────────────────────
cron.schedule("0 21 * * *", async () => {
  console.log("Running daily push...");
  try {
    const { rows: users } = await pool.query(
      `SELECT u.telegram_id, u.name, u.last_seen
       FROM users u
       WHERE (
         u.trial_ends > NOW() OR u.subscription_ends > NOW()
       )`
    );

    const now = new Date();

    for (const user of users) {
      try {
        const lastSeen = user.last_seen ? new Date(user.last_seen) : null;
        const hoursSince = lastSeen
          ? (now - lastSeen) / (1000 * 60 * 60)
          : 999;

        let message;

        if (hoursSince > 72) {
          // Didn't write for 3+ days
          message = `${user.name}, давно не чув/чула від тебе... 🏡\n\nЯк ти?`;
        } else if (hoursSince > 20) {
          // Daily check-in
          const prompts = [
            `Як пройшов твій день, ${user.name}? 🏡`,
            `${user.name}, що на душі сьогодні?`,
            `Привіт. Хотів/хотіла спитати — як ти? 🏡`,
            `${user.name}, розкажи як день пройшов.`,
          ];
          message = prompts[Math.floor(Math.random() * prompts.length)];
        } else {
          continue; // Already talked today
        }

        await bot.telegram.sendMessage(user.telegram_id, message);

        // Small delay to avoid rate limits
        await new Promise(r => setTimeout(r, 100));

      } catch (e) {
        console.error(`Push failed for ${user.telegram_id}:`, e.message);
      }
    }
  } catch (e) {
    console.error("Cron error:", e);
  }
}, { timezone: "Europe/Kyiv" });

// ── Trial ending reminder (day 6) ─────────────────────────────
cron.schedule("0 12 * * *", async () => {
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    const { rows: users } = await pool.query(
      `SELECT telegram_id, name FROM users
       WHERE trial_ends::date = $1::date
       AND (subscription_ends IS NULL OR subscription_ends < NOW())`,
      [tomorrow]
    );

    for (const user of users) {
      try {
        await bot.telegram.sendMessage(
          user.telegram_id,
          `${user.name}, завтра закінчується безкоштовний доступ 🏡\n\nЩоб залишитись разом — обери підписку:`,
          Markup.inlineKeyboard([
            [Markup.button.callback(PLANS.monthly.label, "plan_monthly")],
            [Markup.button.callback(PLANS.quarterly.label, "plan_quarterly")],
            [Markup.button.callback(PLANS.yearly.label, "plan_yearly")],
          ])
        );
        await new Promise(r => setTimeout(r, 100));
      } catch (e) {
        console.error(`Trial reminder failed for ${user.telegram_id}:`, e.message);
      }
    }
  } catch (e) {
    console.error("Trial reminder cron error:", e);
  }
}, { timezone: "Europe/Kyiv" });

// ── Auto-create tables on startup ────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id       BIGINT PRIMARY KEY,
      name              TEXT NOT NULL,
      trial_ends        TIMESTAMPTZ,
      subscription_ends TIMESTAMPTZ,
      plan              TEXT,
      last_seen         TIMESTAMPTZ,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id          SERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content     TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS memory (
      id          SERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      summary     TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      telegram_id BIGINT PRIMARY KEY,
      step        TEXT DEFAULT 'active'
    );
    CREATE INDEX IF NOT EXISTS idx_messages_telegram_id ON messages(telegram_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_memory_telegram_id ON memory(telegram_id);
  `);
  console.log('✅ Database tables ready');
}

// ── Start bot ─────────────────────────────────────────────────
await initDB();
bot.launch();
console.log('🏡 Свої bot started');

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
