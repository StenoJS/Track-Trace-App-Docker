// Herkent bezorgmails en zet ze om in een compact statusobject.
//
// Twee tiers, bewust gescheiden:
//
// Tier 1: DHL/PostNL, herkend op AFZENDER. Gebaseerd op echte voorbeeldmails
// (aug 2026): DHL zet de trackingcode altijd tussen haakjes in het
// onderwerp, PostNL zet 'm alleen in de body onder "Track & trace-code".
// Beide koeriers leggen de status al leesbaar in het onderwerp, dus we
// hoeven geen eigen tracking-API te bevragen. Betrouwbaar, weinig kans op
// valse positieven.
//
// Tier 2: alle overige vervoerders/webshops (DPD, PPL, GLS, UPS, bpost, ...),
// herkend op INHOUD i.p.v. afzender -- nodig zodra mail breder binnenkomt dan
// alleen DHL/PostNL (bv. via een dedicated mailbox met forward-regels).
// Onvermijdelijk fuzzier: elke webshop gebruikt zijn eigen sjabloon. Gebouwd
// en getest tegen echte voorbeelden (LEGO/DPD, Retourdeal/DPD,
// MyParcel/PostNL, Filamentor/PPL) maar garandeert geen volledige dekking --
// check `docker logs pakket-tracker` als een mail gemist wordt en vul de
// patronen hieronder aan.

const DHL_SENDER_RE = /@(dhlecommerce|dhlparcel|dhl)\.(nl|com)$/i;
const POSTNL_SENDER_RE = /@(edm\.)?postnl\.nl$/i;

const DHL_CODE_RE = /\b(JJD\d{10,}|3S[A-Z0-9]{9,})\b/i;
const POSTNL_CODE_RE = /Track\s*&\s*trace-code\s*\n*\s*([A-Z0-9]{9,})/i;

// Statuswoorden die een mail "ruikt naar een verzendupdate" maken, ongeacht
// afzender of webshop-sjabloon. Bewust breed maar niet oneindig -- vul aan
// als een format gemist wordt.
export const STATUS_KEYWORDS_RE =
  /onderweg|bezorgd|verzonden|wordt bezorgd|afgeleverd|geleverd|shipped|delivered|on its way|volg (je|uw) (bestelling|verzending|pakket)/i;

// Vrij unieke trackingcode-vormen: als zo'n vorm ergens in onderwerp/body
// voorkomt (ook binnen een tracking-URL, zoals bij MyParcel/PostNL-links),
// is de vervoerder met vrij hoge zekerheid bekend, ongeacht sjabloon/label.
const KNOWN_CODE_SHAPES = [
  { courier: "DHL", re: /\bJJD\d{10,}\b/ },
  { courier: "PostNL", re: /\b3S[A-Z0-9]{9,}\b/i },
  { courier: "UPS", re: /\b1Z[0-9A-Z]{16}\b/i },
];

// Vervoerders die vaak wél met naam genoemd worden maar geen unieke
// codevorm hebben (platte cijferreeksen) -- de naam-in-de-buurt is hier de
// extra zekerheid tegen valse positieven (bv. factuurnummers).
const NAMED_COURIER_CODE = [
  { courier: "DPD", nameRe: /\bDPD\b|dpdgroup\.com/i, codeRe: /\b0\d{13}\b/ },
  { courier: "PPL", nameRe: /\bPPL\b/, codeRe: /\b\d{10,12}\b/ },
  { courier: "GLS", nameRe: /\bGLS\b/i, codeRe: /\b\d{11,14}\b/ },
  { courier: "bpost", nameRe: /\bbpost\b/i, codeRe: /\b\d{12,14}\b/ },
];

// Generieke "trackingnummer: CODE"-achtige labels, als laatste redmiddel.
// Vangt ook een vervoerdersnaam vlak vóór het label (bv. "PPL trackingnummer").
const LABELED_CODE_RE =
  /(?:([A-Za-z][A-Za-z .]{1,20}?)\s+)?track(?:ing)?[\s-]*(?:code|nummer|number)\s*[:\s]*\n*\s*([A-Z0-9][A-Z0-9-]{6,24})/i;

function findGenericTrackingCode(haystack) {
  for (const { courier, re } of KNOWN_CODE_SHAPES) {
    const m = re.exec(haystack);
    if (m) return { courier, code: m[0].toUpperCase() };
  }
  for (const { courier, nameRe, codeRe } of NAMED_COURIER_CODE) {
    if (nameRe.test(haystack)) {
      const m = codeRe.exec(haystack);
      if (m) return { courier, code: m[0] };
    }
  }
  const labeled = LABELED_CODE_RE.exec(haystack);
  if (labeled) {
    return { courier: labeled[1] ? labeled[1].trim() : null, code: labeled[2] };
  }
  return null;
}

// Afgeleide, leesbare shopnaam als er geen afzender-displaynaam is:
// "info@retourdeal.nl" -> "Retourdeal". Bij subdomeinen (bv. de CRM-mailer
// "t.crm.lego.com") is het langste label meestal de merknaam, niet het
// eerste ("t") of laatste voor de TLD ("lego" i.p.v. "crm").
function guessShopName(fromName, fromAddress) {
  if (fromName && fromName.trim()) return fromName.trim();
  const domain = (fromAddress || "").split("@")[1] || "";
  const labels = domain.split(".").slice(0, -1); // laatste label = TLD, negeren
  if (labels.length === 0) return null;
  const label = labels.reduce((longest, cur) => (cur.length > longest.length ? cur : longest), "");
  if (!label) return null;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function extractSender(fromHeader) {
  // fromHeader kan "Naam <adres@domein>" of alleen "adres@domein" zijn.
  const match = /<([^>]+)>/.exec(fromHeader);
  return (match ? match[1] : fromHeader).trim().toLowerCase();
}

/**
 * @param {{from: string, fromName?: string, subject: string, text: string, date: Date, messageId: string}} mail
 * @returns {null | {courier: string|null, shop: string|null, trackingCode: string|null, statusText: string, date: Date, messageId: string}}
 */
export function parseCourierMail(mail) {
  const sender = extractSender(mail.from);
  const subject = (mail.subject || "").trim();

  // Tier 1: DHL
  if (DHL_SENDER_RE.test(sender)) {
    const codeMatch = DHL_CODE_RE.exec(subject) || DHL_CODE_RE.exec(mail.text || "");
    return {
      courier: "DHL",
      shop: null,
      trackingCode: codeMatch ? codeMatch[1] : null,
      // DHL-onderwerpen zijn zelf al de statustekst, met de code tussen haakjes erachter.
      statusText: subject.replace(/\s*\([A-Z0-9]{9,}\)\s*$/i, "").trim() || subject,
      date: mail.date,
      messageId: mail.messageId,
    };
  }

  // Tier 1: PostNL
  if (POSTNL_SENDER_RE.test(sender)) {
    const codeMatch = POSTNL_CODE_RE.exec(mail.text || "");
    return {
      courier: "PostNL",
      shop: null,
      trackingCode: codeMatch ? codeMatch[1] : null,
      statusText: subject,
      date: mail.date,
      messageId: mail.messageId,
    };
  }

  // Tier 2: overige vervoerders/webshops, op inhoud i.p.v. afzender.
  const haystack = `${subject}\n${mail.text || ""}`;
  if (!STATUS_KEYWORDS_RE.test(haystack)) return null;

  const found = findGenericTrackingCode(haystack);
  if (!found) return null;

  return {
    courier: found.courier,
    shop: guessShopName(mail.fromName, sender),
    trackingCode: found.code,
    statusText: subject,
    date: mail.date,
    messageId: mail.messageId,
  };
}

const STATUS_EMOJI = [
  [/bezorgd|afgeleverd|geleverd|delivered/i, "✅"],
  [/voor de deur|vandaag|vanavond|onderweg|on its way/i, "🚚"],
  [/nieuw pakket|verwacht|verzonden|shipped/i, "📦"],
  [/weer/i, "⛅"],
];

function emojiFor(statusText) {
  for (const [re, emoji] of STATUS_EMOJI) {
    if (re.test(statusText)) return emoji;
  }
  return "📦";
}

function headerFor(parsed) {
  if (parsed.courier && parsed.shop) return `${parsed.courier} via ${parsed.shop}`;
  return parsed.courier || parsed.shop || "Pakket";
}

export function formatTelegramMessage(parsed) {
  const emoji = emojiFor(parsed.statusText);
  const lines = [`${emoji} *${escapeMd(headerFor(parsed))}* — ${escapeMd(parsed.statusText)}`];
  if (parsed.trackingCode) {
    lines.push(`Track & trace: \`${parsed.trackingCode}\``);
  }
  return lines.join("\n");
}

function escapeMd(text) {
  // Minimale Markdown-escaping voor Telegram's legacy "Markdown"-modus.
  return text.replace(/([_*[\]`])/g, "\\$1");
}
