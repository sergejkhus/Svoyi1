// ── profiler.js — система профілювання особистості ───────────
import Anthropic from "@anthropic-ai/sdk";
import pg from "pg";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── Питання для профілювання ──────────────────────────────────
// Кожне питання має: id, шар, тригер (коли задавати), саме питання, як аналізувати
export const QUESTIONS = [

  // ── ШАР 1: Стиль спілкування ─────────────────────────────
  {
    id: "comm_style",
    layer: 1,
    trigger: "after_name", // після знайомства
    minMessages: 2,
    maxMessages: 6,
    question: "До речі — як тобі зручніше: коли просто слухають, чи коли говорять що думають?",
    analyzePrompt: "Людина відповіла на питання 'слухають чи говорять що думають': '{answer}'. Визнач стиль: LISTENER (хоче щоб слухали) / DIALOGUE (хоче діалог і думки) / ADAPTIVE (залежить від ситуації). Відповідь тільки одним словом.",
    field: "comm_style",
  },
  {
    id: "support_need",
    layer: 1,
    trigger: "after_first_topic",
    minMessages: 4,
    maxMessages: 10,
    question: "Ти зазвичай сам/сама розбираєшся з усім чи тобі важливо щоб хтось був поруч?",
    analyzePrompt: "Людина відповіла на питання про самостійність: '{answer}'. Визнач: INDEPENDENT (самостійний) / SUPPORT_SEEKER (потребує підтримки) / BOTH (залежить). Відповідь тільки одним словом.",
    field: "support_need",
  },

  // ── ШАР 2: Стиль прив'язаності ───────────────────────────
  {
    id: "attach_open",
    layer: 2,
    trigger: "topic_relations_or_loneliness",
    minMessages: 6,
    maxMessages: 20,
    question: "Коли тобі погано — ти зазвичай говориш людям чи тримаєш в собі?",
    analyzePrompt: "Людина відповіла на питання 'говориш чи тримаєш в собі': '{answer}'. Визнач: OPEN (ділиться) / CLOSED (тримає в собі) / SELECTIVE (з деякими). Відповідь тільки одним словом.",
    field: "attach_open",
  },
  {
    id: "attach_trust",
    layer: 2,
    trigger: "topic_friends_or_family",
    minMessages: 8,
    maxMessages: 25,
    question: "Є у тебе людина якій ти довіряєш повністю?",
    analyzePrompt: "Людина відповіла на питання про довіру: '{answer}'. Визнач: HAS_TRUST (є така людина) / NO_TRUST (немає) / UNSURE (не впевнений). Відповідь тільки одним словом.",
    field: "attach_trust",
  },
  {
    id: "attach_conflict",
    layer: 2,
    trigger: "topic_conflict_or_relations",
    minMessages: 10,
    maxMessages: 30,
    question: "Після сварки ти перший/перша миришся чи чекаєш?",
    analyzePrompt: "Людина відповіла на питання 'миришся першим чи чекаєш': '{answer}'. Визнач тип прив'язаності: ANXIOUS (мириться першим — боїться втратити) / AVOIDANT (чекає — тримає дистанцію) / SECURE (залежить від ситуації). Відповідь тільки одним словом.",
    field: "attach_conflict",
  },
  {
    id: "attach_alone",
    layer: 2,
    trigger: "topic_loneliness_or_stress",
    minMessages: 12,
    maxMessages: 35,
    question: "Самотність для тебе — це відпочинок чи щось що тисне?",
    analyzePrompt: "Людина відповіла на питання про самотність: '{answer}'. Визнач: RECHARGES (самотність = відпочинок, уникаючий тип) / DRAINS (самотність тисне, тривожний тип) / NEUTRAL. Відповідь тільки одним словом.",
    field: "attach_alone",
  },
  {
    id: "attach_ask_help",
    layer: 2,
    trigger: "any",
    minMessages: 15,
    maxMessages: 40,
    question: "Тобі легко просити про допомогу?",
    analyzePrompt: "Людина відповіла на питання 'легко просити допомогу': '{answer}'. Визнач: EASY (легко) / HARD (важко) / DEPENDS. Відповідь тільки одним словом.",
    field: "attach_ask_help",
  },
  {
    id: "attach_fear",
    layer: 2,
    trigger: "topic_fear_or_future",
    minMessages: 18,
    maxMessages: 50,
    question: "Що тебе більше лякає — залишитись одному/одній чи залежати від когось?",
    analyzePrompt: "Людина відповіла на питання про страх самотності vs залежності: '{answer}'. Визнач: FEARS_ALONE (тривожний тип) / FEARS_DEPEND (уникаючий тип) / FEARS_BOTH (дезорганізований) / NEITHER. Відповідь тільки одним словом.",
    field: "attach_fear",
  },

  // ── ШАР 3: Big Five + Копінг ──────────────────────────────
  {
    id: "neuroticism",
    layer: 3,
    trigger: "topic_stress_or_anxiety",
    minMessages: 10,
    maxMessages: 30,
    question: "Ти довго переживаєш після неприємних ситуацій чи швидко відходиш?",
    analyzePrompt: "Людина відповіла на питання про переживання: '{answer}'. Визнач рівень нейротизму: HIGH (довго переживає) / LOW (швидко відходить) / MEDIUM. Відповідь тільки одним словом.",
    field: "neuroticism",
  },
  {
    id: "anxiety_level",
    layer: 3,
    trigger: "any",
    minMessages: 12,
    maxMessages: 35,
    question: "Ти часто думаєш про те що може піти не так?",
    analyzePrompt: "Людина відповіла на питання про тривожні думки: '{answer}'. Визнач: HIGH_ANXIETY / LOW_ANXIETY / MEDIUM_ANXIETY. Відповідь тільки одним словом.",
    field: "anxiety_level",
  },
  {
    id: "introversion",
    layer: 3,
    trigger: "topic_social_or_energy",
    minMessages: 14,
    maxMessages: 40,
    question: "Після довгого дня з людьми ти втомлений/втомлена чи навпаки заряджений/заряджена?",
    analyzePrompt: "Людина відповіла на питання про енергію після спілкування: '{answer}'. Визнач: INTROVERT (втомлюється) / EXTROVERT (заряджається) / AMBIVERT. Відповідь тільки одним словом.",
    field: "introversion",
  },
  {
    id: "coping_style",
    layer: 3,
    trigger: "topic_problem_or_stress",
    minMessages: 16,
    maxMessages: 45,
    question: "Коли є якась проблема — ти одразу шукаєш рішення чи спочатку потрібно виговоритись?",
    analyzePrompt: "Людина відповіла на питання про копінг: '{answer}'. Визнач: PROBLEM_FOCUSED (шукає рішення) / EMOTION_FOCUSED (виговорюється) / BOTH. Відповідь тільки одним словом.",
    field: "coping_style",
  },
  {
    id: "stress_relief",
    layer: 3,
    trigger: "topic_stress",
    minMessages: 20,
    maxMessages: 55,
    question: "Коли дуже важко — що найкраще допомагає? Поговорити, зайнятись чимось, чи побути на самоті?",
    analyzePrompt: "Людина відповіла на питання про зняття стресу: '{answer}'. Визнач: SOCIAL_COPING (поговорити) / ACTIVE_COPING (зайнятись) / SOLITUDE_COPING (самота) / MIXED. Відповідь тільки одним словом.",
    field: "stress_relief",
  },
];

// ── Визначення тригерів ───────────────────────────────────────
function checkTrigger(trigger, messages) {
  if (trigger === "any") return true;
  if (trigger === "after_name") return messages.length >= 2;
  if (trigger === "after_first_topic") return messages.length >= 4;

  const text = messages.map(m => m.content).join(" ").toLowerCase();

  const triggers = {
    topic_relations_or_loneliness: ["стосун", "самотн", "партнер", "кохан", "друг", "розлуч"],
    topic_friends_or_family: ["друг", "подруг", "сім", "мама", "тато", "брат", "сестр"],
    topic_conflict_or_relations: ["сварк", "конфлікт", "посварил", "образил", "стосун"],
    topic_loneliness_or_stress: ["самотн", "стрес", "важко", "виснаж", "нікого"],
    topic_fear_or_future: ["страх", "боюс", "майбутн", "тривог", "хвилю"],
    topic_stress_or_anxiety: ["стрес", "тривог", "хвилю", "важко", "напруг", "паніка"],
    topic_social_or_energy: ["люди", "компані", "втомил", "спілкуванн", "вечірк"],
    topic_problem_or_stress: ["проблем", "не знаю що робити", "стрес", "важко", "вирішит"],
    topic_stress: ["стрес", "важко", "виснаж", "тяжко"],
    topic_conflict: ["сварк", "конфлікт", "посварил"],
  };

  const keywords = triggers[trigger] || [];
  return keywords.some(k => text.includes(k));
}

// ── Ініціалізація таблиць профілів ────────────────────────────
export async function initProfileTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profiles (
      telegram_id   BIGINT PRIMARY KEY,
      comm_style    TEXT,
      support_need  TEXT,
      attach_open   TEXT,
      attach_trust  TEXT,
      attach_conflict TEXT,
      attach_alone  TEXT,
      attach_ask_help TEXT,
      attach_fear   TEXT,
      neuroticism   TEXT,
      anxiety_level TEXT,
      introversion  TEXT,
      coping_style  TEXT,
      stress_relief TEXT,
      attachment_type TEXT,
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS asked_questions (
      telegram_id BIGINT NOT NULL,
      question_id TEXT NOT NULL,
      asked_at    TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (telegram_id, question_id)
    );
  `);
}

// ── Отримати профіль ──────────────────────────────────────────
export async function getProfile(telegramId) {
  const { rows } = await pool.query(
    "SELECT * FROM profiles WHERE telegram_id = $1", [telegramId]
  );
  return rows[0] || null;
}

// ── Зберегти поле профілю ─────────────────────────────────────
async function saveProfileField(telegramId, field, value) {
  await pool.query(
    `INSERT INTO profiles (telegram_id, ${field}, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (telegram_id) DO UPDATE SET ${field} = $2, updated_at = NOW()`,
    [telegramId, value]
  );

  // Оновити загальний тип прив'язаності після накопичення даних
  const profile = await getProfile(telegramId);
  if (profile) {
    const attachType = calcAttachmentType(profile);
    if (attachType) {
      await pool.query(
        `UPDATE profiles SET attachment_type = $1 WHERE telegram_id = $2`,
        [attachType, telegramId]
      );
    }
  }
}

// ── Визначити тип прив'язаності ───────────────────────────────
function calcAttachmentType(profile) {
  let anxious = 0;
  let avoidant = 0;
  let secure = 0;

  if (profile.attach_open === "CLOSED") avoidant++;
  if (profile.attach_open === "OPEN") secure++;
  if (profile.attach_trust === "NO_TRUST") avoidant++;
  if (profile.attach_trust === "HAS_TRUST") secure++;
  if (profile.attach_conflict === "ANXIOUS") anxious += 2;
  if (profile.attach_conflict === "AVOIDANT") avoidant += 2;
  if (profile.attach_conflict === "SECURE") secure++;
  if (profile.attach_alone === "DRAINS") anxious++;
  if (profile.attach_alone === "RECHARGES") avoidant++;
  if (profile.attach_ask_help === "HARD") avoidant++;
  if (profile.attach_ask_help === "EASY") secure++;
  if (profile.attach_fear === "FEARS_ALONE") anxious += 2;
  if (profile.attach_fear === "FEARS_DEPEND") avoidant += 2;
  if (profile.attach_fear === "FEARS_BOTH") return "DISORGANIZED";

  const max = Math.max(anxious, avoidant, secure);
  if (max === 0) return null;
  if (anxious === max) return "ANXIOUS";
  if (avoidant === max) return "AVOIDANT";
  return "SECURE";
}

// ── Аналізувати відповідь через Claude ───────────────────────
async function analyzeAnswer(question, answer) {
  try {
    const prompt = question.analyzePrompt.replace("{answer}", answer);
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 20,
      messages: [{ role: "user", content: prompt }],
    });
    return response.content[0].text.trim().toUpperCase().split(/\s/)[0];
  } catch (e) {
    console.error("Profile analyze error:", e.message);
    return null;
  }
}

// ── Знайти наступне питання для задання ──────────────────────
export async function getNextQuestion(telegramId, messages) {
  // Які вже задавали
  const { rows: asked } = await pool.query(
    "SELECT question_id FROM asked_questions WHERE telegram_id = $1",
    [telegramId]
  );
  const askedIds = new Set(asked.map(r => r.question_id));

  const msgCount = messages.length;

  // Знайти питання яке підходить
  for (const q of QUESTIONS) {
    if (askedIds.has(q.id)) continue;
    if (msgCount < q.minMessages) continue;
    if (msgCount > q.maxMessages) continue;
    if (!checkTrigger(q.trigger, messages)) continue;

    // Не задавати більше одного питання за 5 повідомлень
    const { rows: recent } = await pool.query(
      "SELECT COUNT(*) FROM asked_questions WHERE telegram_id = $1 AND asked_at > NOW() - INTERVAL '5 minutes'",
      [telegramId]
    );
    if (parseInt(recent[0].count) > 0) continue;

    return q;
  }
  return null;
}

// ── Позначити питання як задане ───────────────────────────────
export async function markQuestionAsked(telegramId, questionId) {
  await pool.query(
    `INSERT INTO asked_questions (telegram_id, question_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [telegramId, questionId]
  );
}

// ── Обробити відповідь на профільне питання ───────────────────
export async function processProfileAnswer(telegramId, questionId, answer) {
  const question = QUESTIONS.find(q => q.id === questionId);
  if (!question) return;

  const value = await analyzeAnswer(question, answer);
  if (value) {
    await saveProfileField(telegramId, question.field, value);
    console.log(`Profile [${telegramId}] ${question.field} = ${value}`);
  }
}

// ── Перевірити чи це відповідь на профільне питання ──────────
export async function getPendingQuestion(telegramId) {
  const { rows } = await pool.query(
    `SELECT question_id FROM asked_questions
     WHERE telegram_id = $1
     AND asked_at > NOW() - INTERVAL '10 minutes'
     ORDER BY asked_at DESC LIMIT 1`,
    [telegramId]
  );
  return rows[0]?.question_id || null;
}

// ── Згенерувати інструкції на основі профілю ─────────────────
export function buildProfileInstructions(profile) {
  if (!profile) return "";

  const lines = ["\n\n[ПРОФІЛЬ КОРИСТУВАЧА — адаптуй стиль спілкування]"];

  // Стиль спілкування
  if (profile.comm_style === "LISTENER") {
    lines.push("Стиль: хоче щоб слухали. Мінімум порад. Максимум простору і тиші.");
  } else if (profile.comm_style === "DIALOGUE") {
    lines.push("Стиль: любить живий діалог. Можна жартувати, провокувати думати, бути прямішим.");
  }

  // Потреба в підтримці
  if (profile.support_need === "INDEPENDENT") {
    lines.push("Самостійний: не нав'язуй допомогу, поважай автономію.");
  } else if (profile.support_need === "SUPPORT_SEEKER") {
    lines.push("Потребує підтримки: більше тепла, присутності, нагадувань що не один/одна.");
  }

  // Тип прив'язаності
  if (profile.attachment_type === "ANXIOUS") {
    lines.push("Тривожний тип прив'язаності: не залишай паузи, не відпускай легко, більше стабільності і передбачуваності. Боїться бути покинутим/покинутою.");
  } else if (profile.attachment_type === "AVOIDANT") {
    lines.push("Уникаючий тип: не тисни, поважай дистанцію, не питай занадто особисте занадто швидко. Цінує простір.");
  } else if (profile.attachment_type === "SECURE") {
    lines.push("Безпечний тип: можна бути чеснішим, іноді м'який виклик, довіряє стосункам.");
  } else if (profile.attachment_type === "DISORGANIZED") {
    lines.push("Дезорганізований тип: дуже обережно, стабільність понад усе, жодних несподіванок.");
  }

  // Нейротизм
  if (profile.neuroticism === "HIGH" || profile.anxiety_level === "HIGH_ANXIETY") {
    lines.push("Висока тривожність: говори спокійно і стабільно, не драматизуй, не посилюй тривогу.");
  } else if (profile.neuroticism === "LOW" && profile.anxiety_level === "LOW_ANXIETY") {
    lines.push("Низька тривожність: можна бути прямішим і чеснішим.");
  }

  // Інтроверсія
  if (profile.introversion === "INTROVERT") {
    lines.push("Інтроверт: дає більше простору між повідомленнями, не перевантажуй питаннями.");
  } else if (profile.introversion === "EXTROVERT") {
    lines.push("Екстраверт: активніший діалог, більше енергії в розмові.");
  }

  // Копінг стиль
  if (profile.coping_style === "PROBLEM_FOCUSED") {
    lines.push("Вирішує проблеми активно: іноді можна обережно запропонувати конкретний крок.");
  } else if (profile.coping_style === "EMOTION_FOCUSED") {
    lines.push("Емоційний копінг: спочатку вислухай повністю, потім м'яко до рішень.");
  }

  // Стрес-рел'єф
  if (profile.stress_relief === "SOLITUDE_COPING") {
    lines.push("Відновлюється в самоті: поважай потребу в тиші.");
  } else if (profile.stress_relief === "SOCIAL_COPING") {
    lines.push("Відновлюється через спілкування: активна розмова допомагає.");
  }

  if (lines.length === 1) return ""; // тільки заголовок — профіль ще порожній
  return lines.join("\n");
}
