// Herkent DHL- en PostNL-bezorgmails en zet ze om in een compact statusobject.
// Gebaseerd op echte voorbeeldmails (aug 2026): DHL zet de trackingcode altijd
// tussen haakjes in het onderwerp, PostNL zet 'm alleen in de body onder
// "Track & trace-code". Beide koeriers leggen de status al leesbaar in het
// onderwerp, dus we hoeven geen eigen tracking-API te bevragen.

const DHL_SENDER_RE = /@(dhlecommerce|dhlparcel|dhl)\.(nl|com)$/i;
const POSTNL_SENDER_RE = /@(edm\.)?postnl\.nl$/i;

const DHL_CODE_RE = /\b(JJD\d{10,}|3S[A-Z0-9]{9,})\b/i;
const POSTNL_CODE_RE = /Track\s*&\s*trace-code\s*\n*\s*([A-Z0-9]{9,})/i;

function extractSender(fromHeader) {
  // fromHeader kan "Naam <adres@domein>" of alleen "adres@domein" zijn.
  const match = /<([^>]+)>/.exec(fromHeader);
  return (match ? match[1] : fromHeader).trim().toLowerCase();
}

/**
 * @param {{from: string, subject: string, text: string, date: Date, messageId: string}} mail
 * @returns {null | {courier: 'DHL'|'PostNL', trackingCode: string|null, statusText: string, date: Date, messageId: string}}
 */
export function parseCourierMail(mail) {
  const sender = extractSender(mail.from);
  const subject = (mail.subject || "").trim();

  if (DHL_SENDER_RE.test(sender)) {
    const codeMatch = DHL_CODE_RE.exec(subject) || DHL_CODE_RE.exec(mail.text || "");
    return {
      courier: "DHL",
      trackingCode: codeMatch ? codeMatch[1] : null,
      // DHL-onderwerpen zijn zelf al de statustekst, met de code tussen haakjes erachter.
      statusText: subject.replace(/\s*\([A-Z0-9]{9,}\)\s*$/i, "").trim() || subject,
      date: mail.date,
      messageId: mail.messageId,
    };
  }

  if (POSTNL_SENDER_RE.test(sender)) {
    const codeMatch = POSTNL_CODE_RE.exec(mail.text || "");
    return {
      courier: "PostNL",
      trackingCode: codeMatch ? codeMatch[1] : null,
      statusText: subject,
      date: mail.date,
      messageId: mail.messageId,
    };
  }

  return null;
}

const STATUS_EMOJI = [
  [/bezorgd/i, "✅"],
  [/voor de deur|vandaag|vanavond|onderweg/i, "🚚"],
  [/nieuw pakket|verwacht/i, "📦"],
  [/weer/i, "⛅"],
];

function emojiFor(statusText) {
  for (const [re, emoji] of STATUS_EMOJI) {
    if (re.test(statusText)) return emoji;
  }
  return "📦";
}

export function formatTelegramMessage(parsed) {
  const emoji = emojiFor(parsed.statusText);
  const lines = [`${emoji} *${parsed.courier}* — ${escapeMd(parsed.statusText)}`];
  if (parsed.trackingCode) {
    lines.push(`Track & trace: \`${parsed.trackingCode}\``);
  }
  return lines.join("\n");
}

function escapeMd(text) {
  // Minimale Markdown-escaping voor Telegram's legacy "Markdown"-modus.
  return text.replace(/([_*[\]`])/g, "\\$1");
}
