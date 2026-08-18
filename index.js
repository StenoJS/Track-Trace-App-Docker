import { loadState, saveState } from "./lib/state.js";
import { fetchNewCourierMails } from "./lib/gmail.js";
import { parseCourierMail, formatTelegramMessage } from "./lib/parse.js";
import { createBot, registerCommands, launchBot, broadcast } from "./lib/telegram.js";

const env = process.env;

function required(name) {
  const value = env[name];
  if (!value) {
    console.error(`Ontbrekende verplichte omgevingsvariabele: ${name}`);
    process.exit(1);
  }
  return value;
}

const config = {
  gmailUser: required("GMAIL_USER"),
  gmailPass: required("GMAIL_APP_PASSWORD"),
  imapHost: env.GMAIL_IMAP_HOST || "imap.gmail.com",
  imapPort: Number(env.GMAIL_IMAP_PORT || 993),
  telegramToken: required("TELEGRAM_BOT_TOKEN"),
  pollIntervalMs: Number(env.POLL_INTERVAL_MINUTES || 10) * 60 * 1000,
  statePath: env.STATE_PATH || "/data/state.json",
};

let state = await loadState(config.statePath);
const persist = () => saveState(config.statePath, state);

const bot = createBot(config.telegramToken);
registerCommands(bot, state, persist);
launchBot(bot).catch((err) => {
  console.error("Telegram-bot kon niet starten:", err.message);
  process.exit(1);
});

console.log(`Pakket-tracker gestart. Poll-interval: ${config.pollIntervalMs / 60000} min.`);

async function pollOnce() {
  const excludeMessageIds = new Set(state.processedMessageIds);
  const sinceDate = state.lastSeenDate ? new Date(state.lastSeenDate) : daysAgo(3);

  let mails;
  try {
    mails = await fetchNewCourierMails({
      host: config.imapHost,
      port: config.imapPort,
      secure: true,
      user: config.gmailUser,
      pass: config.gmailPass,
      sinceDate,
      excludeMessageIds,
    });
  } catch (err) {
    console.error("IMAP-poll mislukt:", err.message);
    return;
  }

  if (mails.length === 0) return;

  console.log(`${mails.length} nieuwe koeriersmail(s) gevonden.`);

  for (const mail of mails) {
    const parsed = parseCourierMail(mail);
    if (!parsed) continue;

    const text = formatTelegramMessage(parsed);
    if (state.chatIds.length === 0) {
      console.log("Geen Telegram-chat gekoppeld (stuur /start naar de bot) — bericht overgeslagen:", text);
    } else {
      await broadcast(bot, state.chatIds, text);
    }

    state.processedMessageIds.push(mail.messageId);
    if (!state.lastSeenDate || mail.date > new Date(state.lastSeenDate)) {
      state.lastSeenDate = mail.date.toISOString();
    }
  }

  await persist();
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

async function loop() {
  await pollOnce().catch((err) => console.error("Onverwachte fout tijdens poll:", err));
  setTimeout(loop, config.pollIntervalMs);
}

loop();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    console.log(`${signal} ontvangen, afsluiten...`);
    bot.stop(signal);
    await persist().catch(() => {});
    process.exit(0);
  });
}
