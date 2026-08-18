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
// als een format gemist wordt. Let op: dit dekt NIET elk DHL/PostNL-eigen
// onderwerp (zie KNOWN_CODE_SHAPES hieronder voor waarom dat ook niet moet).
export const STATUS_KEYWORDS_RE =
  /onderweg|bezorgd|verzonden|wordt bezorgd|afgeleverd|geleverd|shipped|delivered|on its way|volg (je|uw) (bestelling|verzending|pakket)|voor de deur|komen we bij je langs|bij je op de stoep/i;

// Vrij unieke trackingcode-vormen: als zo'n vorm ergens in onderwerp/body
// voorkomt (ook binnen een tracking-URL, zoals bij MyParcel/PostNL-links),
// is de vervoerder met vrij hoge zekerheid bekend, ongeacht sjabloon/label.
// Deze zijn zo onderscheidend dat ze GEEN STATUS_KEYWORDS_RE-gate nodig
// hebben (zie findGenericTrackingCode) -- belangrijk want een doorgestuurde
// DHL/PostNL-mail verliest de afzender (tier 1 matcht dan niet meer) maar
// behoudt meestal wel de code, ook als het onderwerp geen statuswoord
// bevat dat we (nog) kennen.
const KNOWN_CODE_SHAPES = [
  // DHL gebruikt meerdere lettervoorvoegsels afhankelijk van route/dienst --
  // JJD zagen we bij DHL eCommerce NL, JVGL bij DHL Parcel via een
  // internationale afzender (Temu). Waarschijnlijk niet uitputtend; zie ook
  // de DHL-fallback in NAMED_COURIER_CODE hieronder voor onbekende prefixen.
  { courier: "DHL", re: /\bJ(?:JD|VGL)\d{10,}\b/ },
  { courier: "PostNL", re: /\b3S[A-Z0-9]{9,}\b/i },
  { courier: "UPS", re: /\b1Z[0-9A-Z]{16}\b/i },
];

// Vervoerders die vaak wél met naam genoemd worden maar geen (volledig
// bekende) unieke codevorm hebben -- de naam-in-de-buurt is hier de extra
// zekerheid tegen valse positieven (bv. factuurnummers).
const NAMED_COURIER_CODE = [
  { courier: "DPD", nameRe: /\bDPD\b|dpdgroup\.com/i, codeRe: /\b0\d{13}\b/ },
  { courier: "PPL", nameRe: /\bPPL\b/, codeRe: /\b\d{10,12}\b/ },
  { courier: "GLS", nameRe: /\bGLS\b/i, codeRe: /\b\d{11,14}\b/ },
  { courier: "bpost", nameRe: /\bbpost\b/i, codeRe: /\b\d{12,14}\b/ },
  // Vangnet voor DHL-prefixen die niet in KNOWN_CODE_SHAPES staan.
  { courier: "DHL", nameRe: /\bDHL\b/i, codeRe: /\b[A-Z]{2,6}\d{10,22}\b/ },
];

// Generieke "trackingnummer: CODE"-achtige labels, als laatste redmiddel.
// Vangt ook een vervoerdersnaam vlak vóór het label (bv. "PPL trackingnummer").
const LABELED_CODE_RE =
  /(?:([A-Za-z][A-Za-z .]{1,20}?)\s+)?track(?:ing)?[\s-]*(?:code|nummer|number)\s*[:\s]*\n*\s*([A-Z0-9][A-Z0-9-]{6,24})/i;

// Alleen KNOWN_CODE_SHAPES-matches (JJD/3S/1Z...) omzeilen de
// statuswoorden-gate in parseCourierMail -- zie uitleg daar.
export function findKnownCodeShape(haystack) {
  for (const { courier, re } of KNOWN_CODE_SHAPES) {
    const m = re.exec(haystack);
    if (m) return { courier, code: m[0].toUpperCase() };
  }
  return null;
}

function findGenericTrackingCode(haystack) {
  const known = findKnownCodeShape(haystack);
  if (known) return known;

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

// Strip "Fwd:"/"Fw:"/"Doorgestuurd:"/"RE:"-voorvoegsels die een forward of
// reply toevoegt, en een eventuele trackingcode tussen haakjes aan het eind
// (DHL-stijl) -- zodat het Telegram-bericht leesbaar blijft ook als de mail
// is doorgestuurd.
function cleanSubject(subject) {
  return subject
    .replace(/^(fwd?|fw|doorgestuurd|antw?|re)\s*:\s*/i, "")
    .replace(/\s*\([A-Z0-9]{9,}\)\s*$/i, "")
    .trim();
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

// Gmail zet bij doorsturen altijd een blok "---------- Forwarded message
// ---------" met daaronder "Van: Naam <adres>" (of "From: ..."). Dat is de
// ECHTE oorspronkelijke afzender (de webshop) -- veel nuttiger dan wie het
// toevallig doorstuurde (vaak een ander familie-account, zie Temu/Pokemon-
// voorbeeld). Als die oorspronkelijke afzender zelf DHL/PostNL blijkt te
// zijn (iemand stuurde een echte koeriersmail door), is er geen aparte
// "shop" te tonen -- dat zou dubbelop zijn met de koeriersnaam.
const FORWARDED_FROM_RE = /^(?:Van|From):\s*([^<\n]+?)\s*<([^>]+)>/im;

function resolveShopName(mail, sender) {
  const match = FORWARDED_FROM_RE.exec(mail.text || "");
  if (match) {
    const [, name, email] = match;
    const lowerEmail = email.trim().toLowerCase();
    if (DHL_SENDER_RE.test(lowerEmail) || POSTNL_SENDER_RE.test(lowerEmail)) return null;
    return name.trim() || null;
  }
  return guessShopName(mail.fromName, sender);
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
      statusText: cleanSubject(subject) || subject,
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
      statusText: cleanSubject(subject) || subject,
      date: mail.date,
      messageId: mail.messageId,
    };
  }

  // Tier 2: overige vervoerders/webshops, én doorgestuurde DHL/PostNL-mail
  // (afzender is dan het eigen adres van de forwarder, dus tier 1 hierboven
  // matcht niet meer).
  const haystack = `${subject}\n${mail.text || ""}`;

  // Een bekende, onderscheidende codevorm (JJD/3S/1Z) is op zichzelf al
  // genoeg bewijs -- geen statuswoorden-gate nodig. Belangrijk juist voor
  // doorgestuurde DHL-mail: bezorgvenster-onderwerpen als "We staan vandaag
  // voor de deur" bevatten geen woord uit STATUS_KEYWORDS_RE, maar de code
  // staat gewoon nog tussen haakjes.
  const knownShape = findKnownCodeShape(haystack);
  if (knownShape) {
    return {
      courier: knownShape.courier,
      shop: resolveShopName(mail, sender),
      trackingCode: knownShape.code,
      statusText: cleanSubject(subject) || subject,
      date: mail.date,
      messageId: mail.messageId,
    };
  }

  // Overige vervoerders (platte cijfercodes e.d.): wél de statuswoorden-gate,
  // anders is elk toevallig getal in een factuur- of ordernummer een "match".
  if (!STATUS_KEYWORDS_RE.test(haystack)) return null;

  const found = findGenericTrackingCode(haystack);
  if (!found) return null;

  return {
    courier: found.courier,
    shop: resolveShopName(mail, sender),
    trackingCode: found.code,
    statusText: cleanSubject(subject) || subject,
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

// Publieke track&trace-URL's. DHL en DPD zijn overgenomen uit echte
// notificatiemails (dus bevestigd werkend), UPS/PPL uit hun eigen
// documentatie/site. PostNL vereist ook de postcode van de ontvanger --
// zie postnlTrackingUrl() hieronder voor hoe dat wordt opgelost.
const TRACKING_URL_BUILDERS = {
  DHL: (code) => `https://my.dhlecommerce.nl/go-track-trace?role=consumer-receiver&tc=${encodeURIComponent(code)}`,
  DPD: (code) => `https://www.dpdgroup.com/nl/mydpd/my-parcels/search?lang=nl&parcelNumber=${encodeURIComponent(code)}`,
  UPS: (code) => `https://www.ups.com/track?tracknum=${encodeURIComponent(code)}`,
  PPL: (code) => `https://www.ppl.cz/en/track-a-shipment?shipmentId=${encodeURIComponent(code)}`,
};

// Officieel PostNL-deeplink-format (developer.postnl.nl): B=barcode,
// P=postcode, D=landcode, T=C (consument). Zonder P= kom je nog steeds op
// de juiste pagina met de code al ingevuld -- moet je alleen zelf nog de
// postcode intypen in het formulier. Mét een geconfigureerde postcode
// (POSTNL_POSTCODE) gaat de link meteen naar het resultaat.
function postnlTrackingUrl(code, postcode) {
  const params = new URLSearchParams({ B: code, D: "NL", T: "C" });
  if (postcode) params.set("P", postcode.replace(/\s+/g, "").toUpperCase());
  return `https://postnl.nl/tracktrace/?${params.toString()}`;
}

function buildTrackingUrl(courier, code, postnlPostcode) {
  if (courier === "PostNL") return postnlTrackingUrl(code, postnlPostcode);
  const builder = courier && TRACKING_URL_BUILDERS[courier];
  return builder ? builder(code) : null;
}

/**
 * @param {ReturnType<typeof parseCourierMail>} parsed
 * @param {{postnlPostcode?: string}} [options] - eigen postcode, voor een
 *   direct werkende PostNL-link i.p.v. eentje die nog om de postcode vraagt.
 */
export function formatTelegramMessage(parsed, options = {}) {
  const emoji = emojiFor(parsed.statusText);
  const lines = [`${emoji} *${escapeMd(headerFor(parsed))}* — ${escapeMd(parsed.statusText)}`];
  if (parsed.trackingCode) {
    // Telegram's legacy Markdown-modus staat geen geneste entities toe (dus
    // geen `code` binnen een [link](url)) -- daarom losse regels: een schone
    // klikbare link erboven, de kale code eronder voor kopiëren/handmatig
    // invoeren elders.
    const url = buildTrackingUrl(parsed.courier, parsed.trackingCode, options.postnlPostcode);
    if (url) {
      lines.push(`[Track & trace](${url})`);
    }
    lines.push(`\`${parsed.trackingCode}\``);
  }
  return lines.join("\n");
}

function escapeMd(text) {
  // Minimale Markdown-escaping voor Telegram's legacy "Markdown"-modus.
  return text.replace(/([_*[\]`])/g, "\\$1");
}
