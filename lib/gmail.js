import { ImapFlow } from "imapflow";

// Afzenderdomeinen van DHL- en PostNL-bezorgnotificaties (bevestigd op basis
// van echte mails in de inbox, aug 2026). dhlparcel.nl/dhl.com staan er ook
// bij hoewel nog niet gezien, want DHL noemt die zelf als geldige afzenders
// in de footer van hun mails.
const COURIER_DOMAINS = ["dhlecommerce.nl", "dhlparcel.nl", "dhl.com", "postnl.nl"];

function isCourierSender(address) {
  const lower = (address || "").toLowerCase();
  return COURIER_DOMAINS.some((d) => lower === d || lower.endsWith(`@${d}`) || lower.endsWith(`.${d}`));
}

// Zoekt het eerste text/plain-deel in een IMAP bodyStructure-boom.
// Retourneert: het part-id (string) voor multipart-berichten, null voor een
// bericht dat zelf al één plain-text deel is (download zonder part-arg),
// of undefined als er geen text/plain-deel gevonden is.
function findPlainTextPart(node) {
  if (!node) return undefined;
  if (String(node.type).toLowerCase() === "text/plain") {
    return node.part ?? null;
  }
  if (Array.isArray(node.childNodes)) {
    for (const child of node.childNodes) {
      const found = findPlainTextPart(child);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Haalt nieuwe DHL/PostNL-mails op uit INBOX sinds sinceDate.
 * IMAP's SINCE is alleen dag-precies, dus mails van vandaag kunnen meerdere
 * keren teruggegeven worden over opeenvolgende polls — de aanroeper dedupt
 * op messageId (zie state.js / index.js).
 *
 * Twee fases, bewust niet ineen: imapflow staat geen nieuw commando toe
 * (zoals download()) terwijl een for-await over client.fetch() nog loopt op
 * dezelfde connectie — dat gaf een deadlock (poll bleef voor altijd hangen,
 * geen timeout, geen foutmelding). Eerst dus alle envelopes ophalen en
 * filteren, dán pas per match apart bodyStructure+download doen.
 *
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} opts.port
 * @param {boolean} opts.secure
 * @param {string} opts.user
 * @param {string} opts.pass
 * @param {Date|null} opts.sinceDate
 * @param {Set<string>} opts.excludeMessageIds
 */
export async function fetchNewCourierMails({ host, port, secure, user, pass, sinceDate, excludeMessageIds }) {
  const client = new ImapFlow({
    host,
    port,
    secure,
    auth: { user, pass },
    logger: false,
  });

  const results = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const searchCriteria = sinceDate ? { since: sinceDate } : { all: true };

      // Fase 1: goedkope envelope-only pass, filteren op afzender + dedupe.
      const matches = [];
      for await (const msg of client.fetch(searchCriteria, { envelope: true, uid: true })) {
        const fromAddr = msg.envelope?.from?.[0]?.address;
        if (!isCourierSender(fromAddr)) continue;

        const messageId = msg.envelope?.messageId || `uid-${msg.uid}`;
        if (excludeMessageIds.has(messageId)) continue;

        matches.push({
          uid: msg.uid,
          from: fromAddr,
          subject: msg.envelope?.subject || "",
          date: msg.envelope?.date || new Date(),
          messageId,
        });
      }

      // Fase 2: per match apart bodyStructure ophalen + text/plain-deel downloaden.
      for (const match of matches) {
        let text = "";
        try {
          const full = await client.fetchOne(match.uid, { bodyStructure: true }, { uid: true });
          const partId = findPlainTextPart(full.bodyStructure);
          if (partId !== undefined) {
            const { content } = await client.download(match.uid, partId ?? undefined, { uid: true });
            text = await streamToString(content);
          }
        } catch (err) {
          console.error(`Body ophalen mislukt voor uid ${match.uid}:`, err.message);
        }

        results.push({
          from: match.from,
          subject: match.subject,
          text,
          date: match.date,
          messageId: match.messageId,
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  // Oudste eerst versturen, zodat de Telegram-tijdlijn de bezorgvolgorde volgt.
  results.sort((a, b) => a.date - b.date);
  return results;
}
