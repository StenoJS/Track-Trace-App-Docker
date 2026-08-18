import { loadState, saveState } from "./lib/state.js";
import { fetchNewCourierMails } from "./lib/gmail.js";
import { parseCourierMail, formatTelegramMessage } from "./lib/parse.js";
import { broadcast } from "./lib/telegram.js";

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
  // Komma-gescheiden lijst, bv. "123456789,987654321" (jij + familieleden).
  // Los op te vragen via @userinfobot, of je hebt 'm al staan in de
  // bestaande HA Telegram-config als dit token daar ook voor gebruikt wordt.
  telegramChatIds: required("TELEGRAM_CHAT_IDS")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
  pollIntervalMs: Number(env.POLL_INTERVAL_MINUTES || 10) * 60 * 1000,
  statePath: env.STATE_PATH || "/data/state.json",
  // Optioneel: eigen postcode voor een direct werkende PostNL track&trace-
  // link (die vereist ook de postcode, zie lib/parse.js). Zonder deze
  // env-var krijg je nog wel een link, alleen moet je de postcode er zelf
  // nog even bij invullen op hun site.
  postnlPostcode: env.POSTNL_POSTCODE || null,
};

let state = await loadState(config.statePath);
const persist = () => saveState(config.statePath, state);

console.log(
  `Pakket-tracker gestart. Poll-interval: ${config.pollIntervalMs / 60000} min. ` +
    `Ontvangers: ${config.telegramChatIds.length}.`
);

async function pollOnce() {
  const excludeMessageIds = new Set(state.processedMessageIds);
  const sinceDate = state.lastSeenDate ? new Date(state.lastSeenDate) : daysAgo(3);

  let mails;
  try {
    // Harde bovengrens op de hele poll: al liep hier eerder een echte deadlock
    // in (zie git-historie van lib/gmail.js), een timeout zorgt dat een
    // onverwachte hang de volgende cycli niet blijft blokkeren.
    mails = await withTimeout(
      fetchNewCourierMails({
        host: config.imapHost,
        port: config.imapPort,
        secure: true,
        user: config.gmailUser,
        pass: config.gmailPass,
        sinceDate,
        excludeMessageIds,
      }),
      60_000,
      "IMAP-poll"
    );
  } catch (err) {
    console.error("IMAP-poll mislukt:", err.message);
    return;
  }

  if (mails.length === 0) {
    console.log("Geen nieuwe koeriersmail gevonden.");
    return;
  }

  console.log(`${mails.length} nieuwe koeriersmail(s) gevonden.`);

  for (const mail of mails) {
    const parsed = parseCourierMail(mail);
    if (!parsed) {
      // Pre-filter (gmail.js) matchte wel, parseCourierMail niet -- logt
      // zodat een gemist format zichtbaar is i.p.v. stil te verdwijnen.
      console.warn(`Niet herkend, overgeslagen: "${mail.subject}" van ${mail.from}`);
    } else {
      const text = formatTelegramMessage(parsed, { postnlPostcode: config.postnlPostcode });
      await broadcast(config.telegramToken, config.telegramChatIds, text);
    }

    // Altijd als verwerkt markeren -- anders blijft een mail die de
    // pre-filter haalt maar niet herkend wordt élke poll opnieuw
    // terugkomen (oneindige herhaling, nooit verstuurd, nooit als fout
    // zichtbaar) omdat lastSeenDate/excludeMessageIds nooit voorbij hem
    // komen.
    state.processedMessageIds.push(mail.messageId);
    if (!state.lastSeenDate || mail.date > new Date(state.lastSeenDate)) {
      state.lastSeenDate = mail.date.toISOString();
    }
  }

  await persist();
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} duurde langer dan ${ms}ms`)), ms)),
  ]);
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
    await persist().catch(() => {});
    process.exit(0);
  });
}
