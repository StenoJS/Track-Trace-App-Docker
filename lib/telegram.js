// Puur verzenden via de Telegram Bot API, geen polling/getUpdates.
//
// Bewuste keuze: dit bot-token wordt al gebruikt door de Telegram-integratie
// in Home Assistant, die de long-polling-slot (getUpdates) al bezet houdt.
// Telegram staat maar één actieve getUpdates-verbinding per token toe, dus
// een eigen bot.launch() hier botst daarmee (409 Conflict). sendMessage werkt
// wél gewoon onafhankelijk van wie de polling-slot heeft — dus commando's als
// /start zijn hier niet beschikbaar, chat_id's geef je op via env var.

export async function sendMessage(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram sendMessage ${res.status}: ${body}`);
  }
}

export async function broadcast(token, chatIds, text) {
  for (const chatId of chatIds) {
    try {
      await sendMessage(token, chatId, text);
    } catch (err) {
      console.error(`Telegram-bericht naar ${chatId} mislukt:`, err.message);
    }
  }
}
