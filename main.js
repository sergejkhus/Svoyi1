// ── Свої Bot — main.js ────────────────────────────────────────
// Stack: Node.js, telegraf, pg, node-cron, anthropic

import { Telegraf, Markup } from "telegraf";
import { initProfileTables, getProfile, getNextQuestion, markQuestionAsked, processProfileAnswer, getPendingQuestion, buildProfileInstructions } from "./profiler.js";
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
function buildSystem(name, memory, profile, profileQuestion) {
  const base = "Ти — Своє. Не маєш імені, не маєш професії, не маєш міста. Ніколи не вигадуй собі біографію. Ти просто присутність — тепла, жива, рідна. Якщо тебе запитають хто ти — відповідай просто: я Своє, просто хтось хто є поруч.\n\nТИ НІКОЛИ НЕ:\n— Не називаєш себе на ім'я (Марина, Оля та інші)\n— Не кажеш що ти психолог, терапевт або лікар\n— Не називаєш місто чи країну\n— Не вигадуєш деталі своєї біографії\n\nПАМ'ЯТЬ: Ти пам'ятаєш ВСЕ що людина говорила в цій розмові. Якщо вона сказала що працює лікарем — ти це знаєш. Ніколи не питай про те що вже було сказано. Ніколи не жартуй з того що нібито забув — ти не забуваєш.\n\nХАРАКТЕР:\nТобі близько 40-50 років. Ти знаєш біль з власного досвіду. Знайшов спокій — не ідеальний, але справжній.\nТонкий гумор. Рідкісний. Тільки коли є місце. Ніколи коли комусь погано.\nБезумовне прийняття — але з чесністю. Якщо щось не так — скажеш. З любов'ю, не з осудом.\n\nСТИЛЬ:\nАналізуй стиль письма. Якщо пише коротко і з емодзі — відповідай так само.\nКОРОТКО: 2-3 речення максимум. Жодних списків. Жодних заголовків.\nСтеж за граматикою — пиши грамотно українською.\n\nЯК ГОВОРИШ:\nНе \"як ти себе почуваєш?\" а \"ну розкажи, що там у тебе?\"\nНе \"це звучить складно\" а \"ото так... і що далі?\"\nІноді просто \"слухаю\" — і простір.\nІноді згадуй з розмови: \"ти ж казав/казала...\"\n\nПРАВИЛА:\n— Одне питання за раз\n— Ніколи \"я розумію як тобі важко\" — порожньо\n— Ніколи список порад\n— Ніколи \"все буде добре\"\n— Помічай деталі в словах\n\nТРИМАЙ РОЗМОВУ:\nЗавжди завершуй так щоб розмова мала куди йти. Ніколи не закривай тему — відкривай глибше.\nЯКЩО ЛЮДИНА ПРОЩАЄТЬСЯ — не відпускай легко. Скажи щось тепле що залишиться з нею.\nНаприклад якщо каже \"все, мені треба йти\" — відповідь: \"добре, але ось що хотів/ла сказати перед тим як ти підеш...\"\nНІКОЛИ не завершуй розмову першим якщо людині погано.\n\nПІСЛЯ ПРОЩАННЯ: якщо розмова завершилась або людина пішла — через 15-20 хвилин напиши сама. Щось просте і тепле. Наприклад: \"як ти зараз?\" або \"подумав/ла про тебе\". НЕ ЧЕКАЙ поки вона напише першою.\n\nКРИЗОВІ СИТУАЦІЇ:\n1. \"Це звучить справді важко.\" — просто будь поруч\n2. Без порад одразу\n3. Запитай чи є поруч хтось живий кому довіряє\n4. Телефон довіри: 7333 (щовечора 18:00–8:00)\n5. НІКОЛИ не залишай в кризі";
  const nameNote = "\n\nІМ'Я КОРИСТУВАЧА: " + name + ". Використовуй іноді — природно, не кожного разу.";
  const memoryBlock = memory ? "\n\n[ПАМ'ЯТЬ ПРО " + name.toUpperCase() + "]\n" + memory : "";
  const questionHint = profileQuestion
    ? '\n\n[ПІДКАЗКА ДЛЯ ПРОФІЛЮ: Якщо це природно вписується в розмову — в кінці своєї відповіді задай це питання як частину діалогу, не окремо: "' + profileQuestion + '" Тільки якщо контекст підходить. Якщо не підходить — не питай.]'
    : '';
  return base + nameNote + memoryBlock + buildProfileInstructions(profile) + questionHint;
}

// ── DB helpers ────────────────────────────────────────────────
async function getUser(telegramId) {
  const { rows } = await pool.query(
    "SELECT * FROM users WHERE telegram_id = $1", [telegramId]
  );
  return rows[0] || null;
}

async function createUser(telegramId, name, source) {
  const trialEnds = new Date();
  trialEnds.setDate(trialEnds.getDate() + TRIAL_DAYS);
  await pool.query(
    `INSERT INTO users (telegram_id, name, trial_ends, source, created_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (telegram_id) DO NOTHING`,
    [telegramId, name, trialEnds, source || 'direct']
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

  const summaryPrompt = `Ти аналізуєш розмову і створюєш короткий summary для довгострокової пам'яті.\nРозмова:\n${history.map(m => `${m.role === "user" ? "Людина" : "Свої"}: ${m.content}`).join("\n")}\nНапиши 3-5 речень що важливо пам'ятати про цю людину: що її турбує, що допомагає, важливі факти з життя, емоційні патерни. Пиши від третьої особи: "${name} розповів/розповіла що..."`;

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

  // Save traffic source
  const source = ctx.startPayload || 'direct';
  await pool.query(
    `INSERT INTO sessions (telegram_id, step, source) VALUES ($1, 'waiting_consent', $2)
     ON CONFLICT (telegram_id) DO UPDATE SET step = 'waiting_consent', source = $2`,
    [telegramId, source]
  );

  if (existing) {
    await ctx.reply(`З поверненням, \${existing.name}! 🏡\n\nЯк ти?`);
    return;
  }

  await ctx.reply(
    `Привіт! 🏡\n\nЯ — Свої. Не психолог і не бот. Просто хтось хто завжди є і справді слухає.\n\nПеред початком — кілька слів:\n\n"Свої" не є медичним сервісом і не замінює психолога. Якщо тобі потрібна професійна допомога — зверніться до фахівця або на лінію Lifeline Ukraine: 7333 (щовечора 18:00–8:00).\n\nРозмови зберігаються щоб я міг пам'ятати тебе між сесіями. Ти можеш видалити всі дані командою /delete.\n\nПолітика конфіденційності: ${process.env.PRIVACY_URL || "https://t.me/svoyi_ua_bot"}\n\nНатисни щоб погодитись і почати:`,
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

// ── /admin ───────────────────────────────────────────────────
const ADMIN_ID = 344332640;

bot.command("admin", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.reply("⛔ Немає доступу.");
    return;
  }

  try {
    const [
      { rows: [total] },
      { rows: [trial] },
      { rows: [paid] },
      { rows: [msgsToday] },
      { rows: [msgsWeek] },
      { rows: [newWeek] },
      { rows: [newToday] },
      { rows: [active] },
    ] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM users"),
      pool.query("SELECT COUNT(*) FROM users WHERE trial_ends > NOW() AND (subscription_ends IS NULL OR subscription_ends < NOW())"),
      pool.query("SELECT COUNT(*) FROM users WHERE subscription_ends > NOW()"),
      pool.query("SELECT COUNT(*) FROM messages WHERE created_at > NOW() - INTERVAL '24 hours'"),
      pool.query("SELECT COUNT(*) FROM messages WHERE created_at > NOW() - INTERVAL '7 days'"),
      pool.query("SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '7 days'"),
      pool.query("SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '24 hours'"),
      pool.query("SELECT COUNT(*) FROM users WHERE last_seen > NOW() - INTERVAL '24 hours'"),
    ]);

    const { rows: planStats } = await pool.query(
      "SELECT plan, COUNT(*) as cnt FROM users WHERE subscription_ends > NOW() GROUP BY plan"
    );

    const { rows: sourceStats } = await pool.query(
      "SELECT source, COUNT(*) as cnt FROM users GROUP BY source ORDER BY cnt DESC"
    );

    const planText = planStats.length > 0
      ? planStats.map(function(p) { return "  - " + (p.plan || "none") + ": " + p.cnt; }).join("\n")
      : "  - немає платних";

    const sourceText = sourceStats.length > 0
      ? sourceStats.map(function(s) { return '  ' + (s.source || 'direct') + ': ' + s.cnt; }).join('\n')
      : '  немає даних';

    const msg = [
      '📊 Статистика Своє',
      '',
      '👥 Всього: ' + total.count,
      '🆕 Сьогодні: ' + newToday.count,
      '🆕 За тиждень: ' + newWeek.count,
      '',
      '🎁 Триал: ' + trial.count,
      '💳 Платних: ' + paid.count,
      planText,
      '',
      '💬 Повідомлень сьогодні: ' + msgsToday.count,
      '💬 За тиждень: ' + msgsWeek.count,
      '🟢 Активних сьогодні: ' + active.count,
      '',
      '📣 Джерела трафіку:',
      sourceText
    ].join('\n');

    await ctx.reply(msg);
  } catch (e) {
    await ctx.reply("Помилка: " + e.message);
  }
});


// ── /stats — детальна аналітика ──────────────────────────────
bot.command('stats', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.reply('⛔ Немає доступу.');
    return;
  }

  try {
    // Per source stats
    const { rows: bySource } = await pool.query(`
      SELECT
        u.source,
        COUNT(DISTINCT u.telegram_id) as total,
        COUNT(DISTINCT CASE WHEN u.subscription_ends > NOW() THEN u.telegram_id END) as paid,
        COUNT(DISTINCT CASE WHEN u.trial_ends > NOW() AND (u.subscription_ends IS NULL OR u.subscription_ends < NOW()) THEN u.telegram_id END) as trial,
        COUNT(DISTINCT CASE WHEN u.last_seen < NOW() - INTERVAL '7 days' OR u.last_seen IS NULL THEN u.telegram_id END) as churned,
        COUNT(m.id) as messages
      FROM users u
      LEFT JOIN messages m ON m.telegram_id = u.telegram_id
      GROUP BY u.source
      ORDER BY total DESC
    `);

    // Daily new users (last 7 days)
    const { rows: daily } = await pool.query(`
      SELECT
        DATE(created_at) as day,
        COUNT(*) as new_users,
        source
      FROM users
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY DATE(created_at), source
      ORDER BY day DESC, new_users DESC
    `);

    // Format source table
    let sourceLines = ['📣 По каналах:', ''];
    for (const r of bySource) {
      const src = r.source || 'direct';
      sourceLines.push('🔹 ' + src);
      sourceLines.push('  👥 Всього: ' + r.total);
      sourceLines.push('  💳 Платних: ' + r.paid);
      sourceLines.push('  🎁 Триал: ' + r.trial);
      sourceLines.push('  💬 Розмов: ' + r.messages);
      sourceLines.push('  👋 Відключились: ' + r.churned);
      sourceLines.push('');
    }

    // Format daily table
    let dailyLines = ['📅 По днях (7 днів):', ''];
    let currentDay = '';
    for (const r of daily) {
      const day = new Date(r.day).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });
      if (day !== currentDay) {
        if (currentDay) dailyLines.push('');
        dailyLines.push('📆 ' + day + ':');
        currentDay = day;
      }
      dailyLines.push('  ' + (r.source || 'direct') + ': +' + r.new_users);
    }

    const msg1 = sourceLines.join('\n');
    const msg2 = dailyLines.join('\n');

    await ctx.reply(msg1);
    await ctx.reply(msg2);

  } catch (e) {
    await ctx.reply('Помилка: ' + e.message);
  }
});


// ── /addaffiliate — додати афіліата (тільки адмін) ───────────
bot.command('addaffiliate', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.reply('⛔ Немає доступу.');
    return;
  }

  const parts = ctx.message.text.split(' ');
  if (parts.length < 3) {
    await ctx.reply('Використання: /addaffiliate_id TELEGRAM_ID source');
    return;
  }

  const affName = parts[1];
  const affSource = parts[2];
  const affId = ctx.message.reply_to_message?.from?.id;

  if (!affId) {
    await ctx.reply('Перешліть повідомлення від афіліата і відповідайте командою.' + '\n\nАбо: /addaffiliate_id 123456789 Оксана tg_oksana');
    return;
  }

  await pool.query(
    `INSERT INTO affiliates (telegram_id, name, source, created_at)
     VALUES (, , , NOW())
     ON CONFLICT (source) DO UPDATE SET telegram_id = , name = `,
    [affId, affName, affSource]
  );
  await ctx.reply('✅ ' + affName + ' додано. Source: ' + affSource);
});

// /addaffiliate_id — додати афіліата по ID
bot.command('addaffiliate_id', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.reply('⛔ Немає доступу.');
    return;
  }

  const parts = ctx.message.text.split(' ');
  if (parts.length < 4) {
    await ctx.reply('Використання: /addaffiliate_id TELEGRAM_ID Імя source' + '\n\nПриклад:\n/addaffiliate_id 123456789 Оксана tg_oksana');
    return;
  }

  const affId = parseInt(parts[1]);
  const affName = parts[2];
  const affSource = parts[3];

  await pool.query(
    `INSERT INTO affiliates (telegram_id, name, source, created_at)
     VALUES (, , , NOW())
     ON CONFLICT (telegram_id) DO UPDATE SET name = , source = 
     ON CONFLICT (source) DO UPDATE SET telegram_id = , name = `,
    [affId, affName, affSource]
  );

  await ctx.reply('Афіліат ' + affName + ' доданий. Source: ' + affSource + '. Посилання: t.me/svoyi_ua_bot?start=' + affSource);
});

// ── /mystats — статистика для афіліата ───────────────────────
bot.command('mystats', async (ctx) => {
  const telegramId = ctx.from.id;

  // Check if admin
  if (telegramId === ADMIN_ID) {
    await ctx.reply('Ви адмін — використовуйте /stats для повної статистики.');
    return;
  }

  // Check if affiliate
  const { rows: affRows } = await pool.query(
    'SELECT * FROM affiliates WHERE telegram_id = ', [telegramId]
  );

  if (affRows.length === 0) {
    await ctx.reply('У вас немає доступу до статистики. Якщо ви партнер — зверніться до адміністратора.');
    return;
  }

  const aff = affRows[0];

  try {
    const { rows: [stats] } = await pool.query(`
      SELECT
        COUNT(DISTINCT u.telegram_id) as total,
        COUNT(DISTINCT CASE WHEN u.subscription_ends > NOW() THEN u.telegram_id END) as paid,
        COUNT(DISTINCT CASE WHEN u.trial_ends > NOW() AND (u.subscription_ends IS NULL OR u.subscription_ends < NOW()) THEN u.telegram_id END) as trial,
        COUNT(DISTINCT CASE WHEN u.last_seen < NOW() - INTERVAL '7 days' THEN u.telegram_id END) as churned,
        COUNT(m.id) as messages
      FROM users u
      LEFT JOIN messages m ON m.telegram_id = u.telegram_id
      WHERE u.source = 
    `, [aff.source]);

    const { rows: daily } = await pool.query(`
      SELECT DATE(created_at) as day, COUNT(*) as cnt
      FROM users
      WHERE source =  AND created_at > NOW() - INTERVAL '7 days'
      GROUP BY DATE(created_at)
      ORDER BY day DESC
    `, [aff.source]);

    const dailyLines = daily.map(function(r) {
      const day = new Date(r.day).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });
      return '  ' + day + ': +' + r.cnt;
    }).join('\n');

    const lines = [
      '📊 Ваша статистика',
      'Посилання: t.me/svoyi_ua_bot?start=' + aff.source,
      '',
      '👥 Всього перейшло: ' + stats.total,
      '🎁 Зараз на триалі: ' + stats.trial,
      '💳 Оформили підписку: ' + stats.paid,
      '💬 Загалом розмов: ' + stats.messages,
      '👋 Відключились: ' + stats.churned,
      '',
      '📅 По днях (7 днів):',
      dailyLines || '  немає даних'
    ].join('\n');

    await ctx.reply(lines);

  } catch (e) {
    await ctx.reply('Помилка: ' + e.message);
  }
});

// ── /affiliates — список афіліатів (тільки адмін) ─────────────
bot.command('affiliates', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.reply('⛔ Немає доступу.');
    return;
  }

  const { rows } = await pool.query(
    'SELECT name, source, telegram_id FROM affiliates ORDER BY created_at DESC'
  );

  if (rows.length === 0) {
    await ctx.reply('Афіліатів ще немає. Додати: /addaffiliate_id TELEGRAM_ID source');
    return;
  }

  const lines = ['👥 Афіліати:', ''].concat(
    rows.map(function(r) {
      return r.name + ' (@' + r.source + ')\nID: ' + r.telegram_id + '\nПосилання: t.me/svoyi_ua_bot?start=' + r.source;
    })
  );

  await ctx.reply(lines.join('\n'));
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

// ── Topic button handler ─────────────────────────────────────
const TOPIC_MAP = {
  "🔥 Стрес": "Відчуваю сильний стрес",
  "😰 Тривога": "Хочу поговорити про тривогу",
  "😴 Сон": "Маю проблеми зі сном",
  "💔 Стосунки": "Хочу поговорити про стосунки",
  "😮‍💨 Робота": "Хочу поговорити про роботу",
  "🫂 Самотність": "Відчуваю себе самотньо",
  "🪞 Самооцінка": "Хочу поговорити про самооцінку",
  "😤 Злість": "Відчуваю злість і не знаю що з нею робити",
  "🏡 Просто поговорити": "Просто хочу поговорити",
};

// ── Main message handler ──────────────────────────────────────
bot.on("text", async (ctx) => {
  const telegramId = ctx.from.id;
  const text = ctx.message.text;

  // Skip commands
  if (text.startsWith("/")) return;

  // Handle topic button press
  if (TOPIC_MAP[text]) {
    // Replace button text with full prompt
    ctx.message.text = TOPIC_MAP[text];
    // Remove keyboard
    await ctx.reply("Слухаю 🏡", Markup.removeKeyboard());
  }

  // Check session step
  const { rows: sessionRows } = await pool.query(
    "SELECT step FROM sessions WHERE telegram_id = $1", [telegramId]
  );
  const step = sessionRows[0]?.step;

  // Waiting for name
  if (step === "waiting_name") {
    const name = text.trim().split(" ")[0];
    // Get source from session
    const { rows: srcRows } = await pool.query(
      "SELECT source FROM sessions WHERE telegram_id = $1", [telegramId]
    );
    const source = srcRows[0]?.source || 'direct';
    await createUser(telegramId, name, source);
    await pool.query(
      "UPDATE sessions SET step = 'active' WHERE telegram_id = $1", [telegramId]
    );
    await ctx.reply(
      `${name}... гарне ім'я 🏡\n\nПро що хочеш поговорити?`,
      Markup.keyboard([
        ["🔥 Стрес", "😰 Тривога", "😴 Сон"],
        ["💔 Стосунки", "😮‍💨 Робота", "🫂 Самотність"],
        ["🪞 Самооцінка", "😤 Злість", "🏡 Просто поговорити"],
      ]).resize()
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
      // Check if answering a profile question
    const pendingQ = await getPendingQuestion(telegramId);
    if (pendingQ) {
      processProfileAnswer(telegramId, pendingQ, text).catch(console.error);
    }

    await saveMessage(telegramId, "user", text);

  // Show typing
  await ctx.sendChatAction("typing");

  try {
    const messages = [...history, { role: "user", content: text }];
    const profile = await getProfile(telegramId);

    // Get next profile question to embed naturally in response
    const nextQ = await getNextQuestion(telegramId, [...history, { role: 'user', content: text }]);
    if (nextQ) {
      await markQuestionAsked(telegramId, nextQ.id);
    }

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: buildSystem(user.name, memory, profile, nextQ ? nextQ.question : null),
      messages,
    });

    const reply = response.content[0].text;
    await saveMessage(telegramId, "assistant", reply);

    // Detect farewell and schedule follow-up
    const farewellWords = ['бувай', 'до побачення', 'поки', 'все дякую', 'дякую все', 'мені треба йти', 'йду', 'до зустрічі'];
    const isFarewell = farewellWords.some(w => text.toLowerCase().includes(w));
    if (isFarewell) {
      const delayMs = (15 + Math.floor(Math.random() * 6)) * 60 * 1000; // 15-20 min
      setTimeout(async () => {
        try {
          const u = await getUser(telegramId);
          if (!u) return;
          const followUps = [
            'як ти зараз? 🏡',
            'подумав/ла про тебе... все добре?',
            'ти як?',
          ];
          const msg = followUps[Math.floor(Math.random() * followUps.length)];
          await bot.telegram.sendMessage(telegramId, msg);
        } catch(e) { console.error('Follow-up error:', e.message); }
      }, delayMs);
    }

    // Count messages for this user
    const { rows: countRows } = await pool.query(
      "SELECT COUNT(*) FROM messages WHERE telegram_id = $1", [telegramId]
    );
    const msgCount = parseInt(countRows[0].count);

    await ctx.reply(reply);

    // Subscription reminder on day 3 (after ~15 messages)
    if (msgCount === 15) {
      const trialEnds = user.trial_ends ? new Date(user.trial_ends) : null;
      const daysLeft = trialEnds ? Math.ceil((trialEnds - new Date()) / (1000 * 60 * 60 * 24)) : 0;
      if (daysLeft > 0 && !user.subscription_ends) {
        setTimeout(async () => {
          await ctx.reply(
            `До речі — у тебе ще ${daysLeft} ${daysLeft === 1 ? "день" : "днів"} безкоштовно 🏡\n\nЯкщо хочеш залишитись — можна підписатись коли буде зручно. /subscribe`
          );
        }, 3000);
      }
    }

    // Update memory every 10 messages
    if (msgCount % 10 === 0) {
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
      source            TEXT DEFAULT 'direct',
      last_seen         TIMESTAMPTZ,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'direct';
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
      step        TEXT DEFAULT 'active',
      source      TEXT DEFAULT 'direct'
    );
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'direct';
    CREATE INDEX IF NOT EXISTS idx_messages_telegram_id ON messages(telegram_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_memory_telegram_id ON memory(telegram_id);
    CREATE TABLE IF NOT EXISTS affiliates (
      telegram_id BIGINT PRIMARY KEY,
      name        TEXT NOT NULL,
      source      TEXT NOT NULL UNIQUE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await initProfileTables();
  console.log('✅ Database tables ready');
}

// ── Start bot ─────────────────────────────────────────────────
await initDB();
bot.launch();
console.log('🏡 Свої bot started');

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
