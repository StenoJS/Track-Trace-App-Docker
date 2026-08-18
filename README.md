# Pakket-tracker

Bewaakt je Gmail-inbox op DHL- en PostNL-bezorgmails en stuurt elke
statuswijziging (nieuw pakket, onderweg, voor de deur, bezorgd) door naar
Telegram. Geen DHL/PostNL developer-API nodig — beide koeriers zetten de
status al leesbaar in het onderwerp van hun eigen notificatiemails, dus deze
service leest gewoon mee.

## Hoe het werkt

1. Elke `POLL_INTERVAL_MINUTES` (standaard 10 min) logt de service via IMAP
   in op je Gmail en zoekt nieuwe mail van `@dhlecommerce.nl`, `@dhlparcel.nl`,
   `@dhl.com` en `@postnl.nl`.
2. Het onderwerp (en bij PostNL de "Track & trace-code" in de body) wordt
   omgezet naar een kort Telegram-bericht.
3. Elke bekende Telegram-chat (zie `/start` hieronder) krijgt het bericht.
4. Verwerkte mails worden onthouden in `/data/state.json` (Docker-volume), dus
   een herstart stuurt niets dubbel.

## Zelf instellen (eenmalig)

### 1. Gmail app-wachtwoord

IMAP met een gewoon wachtwoord werkt niet meer bij Gmail. Nodig:

1. Zorg dat 2-staps-verificatie aan staat op je Google-account.
2. Ga naar <https://myaccount.google.com/apppasswords>.
3. Maak een nieuw app-wachtwoord (naam mag vrij zijn, bv. "pakket-tracker").
4. Bewaar het 16-tekens-wachtwoord — dat is `GMAIL_APP_PASSWORD`.

### 2. Telegram

Je hebt al een bot. Nodig is alleen de **bot-token** (van BotFather,
`123456789:AA...`) — dat wordt `TELEGRAM_BOT_TOKEN`. Een chat_id hoef je niet
zelf op te zoeken: stuur na het deployen gewoon `/start` naar je bot vanuit
Telegram, dan onthoudt de service die chat zelf.

Beschikbare commando's in de bot:

- `/start` — koppel deze chat aan de tracker
- `/stop` — ontkoppel deze chat
- `/status` — laatste controle-tijdstip

### 3. Deployen (Portainer, hassio-netwerk)

Zelfde patroon als de andere self-hosted diensten:

1. Nieuwe stack in Portainer, gebaseerd op [docker-compose.yml](./docker-compose.yml)
   uit deze map (of laat Portainer bouwen vanuit een git-repo/pad).
2. Vul de stack-omgevingsvariabelen in **in Portainer zelf** (niet in een
   bestand in git):
   - `GMAIL_USER`
   - `GMAIL_APP_PASSWORD`
   - `TELEGRAM_BOT_TOKEN`
   - `POLL_INTERVAL_MINUTES` (optioneel, default 10)
3. Deploy. Container heeft geen open poort en geen NPM-entry nodig — alle
   verbindingen (IMAP, Telegram long-polling) zijn uitgaand.
4. Stuur `/start` naar je bot.

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
lib/telegram.js    Bot-commando's (/start, /stop, /status) + broadcast
lib/state.js       Persistente state (/data/state.json)
```

## Grenzen van deze aanpak

- Alleen mails die DHL/PostNL zelf al sturen worden doorgegeven — geen
  losstaande "waar is mijn pakket nu precies"-opvraging tussen mails door.
  Kan later als uitbreiding via de (onofficiële) publieke track&trace-pagina's
  van DHL Parcel NL / PostNL, maar dat is bewust buiten scope gehouden voor
  v1 (fragieler, geen officiële API-garantie).
- Herkenning is gebaseerd op regex over echte voorbeeldmails. Als DHL/PostNL
  hun sjablonen wijzigen, kan een statustype gemist worden — check dan
  `docker logs pakket-tracker` en pas `lib/parse.js` aan.
