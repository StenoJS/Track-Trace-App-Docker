# Pakket-tracker

Bewaakt je Gmail-inbox op bezorgmails en stuurt elke statuswijziging (nieuw
pakket, onderweg, voor de deur, bezorgd) door naar Telegram, met een
klikbare track&trace-link erbij. Geen koerier-developer-API nodig — DHL en
PostNL zetten de status al leesbaar in hun eigen notificatiemails, en voor
overige vervoerders/webshops (DPD, PPL, GLS, UPS, bpost, ...) wordt de mail
zelf op inhoud herkend (statuswoord + trackingcode), ook als je 'm hebt
doorgestuurd vanaf een ander account.

## Hoe het werkt

1. Elke `POLL_INTERVAL_MINUTES` (standaard 10 min) logt de service via IMAP
   in op je Gmail en zoekt nieuwe mail. Twee herkenningslagen:
   - **DHL/PostNL rechtstreeks**: afzenderdomein (`@dhlecommerce.nl`,
     `@dhlparcel.nl`, `@dhl.com`, `@postnl.nl`) is genoeg, ongeacht onderwerp.
   - **Alles overig, én doorgestuurde DHL/PostNL-mail**: op inhoud — een
     statuswoord (onderweg/bezorgd/verzonden/...) of een bekende
     trackingcode-vorm (DHL `JJD`/`JVGL`, PostNL `3S`, UPS `1Z`, ...).
2. Bij een doorgestuurde mail wordt de échte oorspronkelijke afzender (de
   webshop, uit Gmail's "Van: ..."-forward-header) als winkelnaam getoond
   i.p.v. wie 'm toevallig doorstuurde.
3. Het bericht krijgt een klikbare `[Track & trace](url)`-link waar mogelijk
   (DHL, DPD, UPS, PPL bevestigd werkend; PostNL alleen met `POSTNL_POSTCODE`
   ingesteld, zie hieronder) plus de kale code eronder om te kopiëren.
4. Elke chat_id in `TELEGRAM_CHAT_IDS` krijgt het bericht.
5. Verwerkte mails worden onthouden in `/data/state.json` (Docker-volume), dus
   een herstart stuurt niets dubbel.

## Zelf instellen (eenmalig)

### 1. Gmail app-wachtwoord

IMAP met een gewoon wachtwoord werkt niet meer bij Gmail. Nodig:

1. Zorg dat 2-staps-verificatie aan staat op je Google-account.
2. Ga naar <https://myaccount.google.com/apppasswords>.
3. Maak een nieuw app-wachtwoord (naam mag vrij zijn, bv. "pakket-tracker").
4. Bewaar het 16-tekens-wachtwoord — dat is `GMAIL_APP_PASSWORD`.

### 2. Telegram

Je hebt al een bot — en dat token wordt ook al gebruikt door de
Telegram-integratie in Home Assistant. Telegram staat maar **één actieve
long-polling-verbinding (getUpdates) per bot-token** toe, dus deze service
doet bewust *geen* eigen polling en heeft dus ook geen `/start`-commando om
zelf een chat_id te ontdekken (dat gaf een `409 Conflict` met HA's eigen
polling). Versturen van berichten (`sendMessage`) botst niet en werkt gewoon
naast HA's integratie.

Nodig:

- `TELEGRAM_BOT_TOKEN` — hetzelfde token als in HA.
- `TELEGRAM_CHAT_IDS` — komma-gescheiden lijst met chat_id's die berichten
  moeten ontvangen. Zoek je eigen chat_id op via `@userinfobot` in Telegram,
  of hergebruik de chat_id die al in je HA Telegram-configuratie staat.

### 3. Deployen (Portainer, hassio-netwerk)

Zelfde patroon als de andere self-hosted diensten:

1. Nieuwe stack in Portainer, gebaseerd op [docker-compose.yml](./docker-compose.yml)
   uit deze map (of laat Portainer bouwen vanuit een git-repo/pad).
2. Vul de stack-omgevingsvariabelen in **in Portainer zelf** (niet in een
   bestand in git):
   - `GMAIL_USER`
   - `GMAIL_APP_PASSWORD`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_IDS`
   - `POLL_INTERVAL_MINUTES` (optioneel, default 10)
   - `POSTNL_POSTCODE` (optioneel) — je eigen postcode zonder spatie, bv.
     `7556HN`. PostNL's track&trace vereist die verplicht naast de code; met
     deze var gaat de link direct naar het resultaat, zonder moet je de
     postcode zelf nog even invullen op hun site (link werkt wel, komt alleen
     niet meteen op de detailpagina uit).
3. Deploy. Container heeft geen open poort en geen NPM-entry nodig — alle
   verbindingen (IMAP, Telegram sendMessage) zijn uitgaand.

## Lokaal draaien (zonder Docker)

```bash
npm install
cp .env.example .env   # vul in
npm start
```

## Structuur

```
index.js          Hoofdloop: poll-interval, dedupe, Telegram-verzending
lib/gmail.js       IMAP-ophalen van nieuwe koeriersmail
lib/parse.js       Onderwerp/body → koerier + trackingcode + statustekst
lib/telegram.js    sendMessage/broadcast via de Telegram Bot API (geen polling)
lib/state.js       Persistente state (/data/state.json)
```

## Grenzen van deze aanpak

- Alleen mails die een koerier/webshop zelf al stuurt worden doorgegeven —
  geen losstaande "waar is mijn pakket nu precies"-opvraging tussen mails
  door (geen eigen tracking-API-polling).
- Herkenning is gebaseerd op regex over echte voorbeeldmails (DHL, PostNL,
  MyParcel, LEGO/DPD, Retourdeal/DPD, Filamentor/PPL, Temu/DHL-JVGL). Als
  een nieuw sjabloon of trackingcode-formaat gemist wordt, staat dat expliciet
  gelogd als `Niet herkend, overgeslagen: "<onderwerp>" van <afzender>` —
  check `docker logs pakket-tracker` en vul `lib/parse.js` aan (met name
  `KNOWN_CODE_SHAPES`/`NAMED_COURIER_CODE`/`STATUS_KEYWORDS_RE`).
- Track&trace-links zijn best-effort (DHL/DPD bevestigd uit echte mails,
  UPS/PPL uit hun documentatie) — als een koerier zijn URL-structuur
  wijzigt, kan een link stuk gaan zonder dat de rest van de herkenning
  daaronder lijdt.
