import { Telegraf } from "telegraf";

/**
 * Bouwt de bot op. Starten (long-polling) gebeurt apart via startBot(),
 * zodat commando's eerst geregistreerd kunnen worden.
 */
export function createBot(token) {
  return new Telegraf(token);
}

/**
 * Registreert de simpele commando's. /start koppelt de chat aan de service
 * zodat je niet handmatig een chat_id hoeft op te zoeken tijdens setup.
 */
export function registerCommands(bot, state, persist) {
  bot.command("start", async (ctx) => {
    const chatId = ctx.chat.id;
    if (!state.chatIds.includes(chatId)) {
      state.chatIds.push(chatId);
      await persist();
    }
    await ctx.reply(
      "📦 Pakket-tracker actief. Je ontvangt hier voortaan updates zodra DHL of PostNL een bezorgmail stuurt."
    );
  });

  bot.command("stop", async (ctx) => {
    const chatId = ctx.chat.id;
    state.chatIds = state.chatIds.filter((id) => id !== chatId);
    await persist();
    await ctx.reply("Uitgeschakeld voor deze chat. Stuur /start om weer aan te zetten.");
  });

  bot.command("status", async (ctx) => {
    await ctx.reply(
      state.lastSeenDate
        ? `Laatst gecontroleerd op ${new Date(state.lastSeenDate).toLocaleString("nl-NL")}.`
        : "Nog geen mail gecontroleerd."
    );
  });
}

/** Start long-polling. Geen inkomend webhook/poort nodig — puur uitgaand. */
export function launchBot(bot) {
  return bot.launch();
}

export async function broadcast(bot, chatIds, text) {
  for (const chatId of chatIds) {
    try {
      await bot.telegram.sendMessage(chatId, text, { parse_mode: "Markdown" });
    } catch (err) {
      console.error(`Telegram-bericht naar ${chatId} mislukt:`, err.message);
    }
  }
}
