import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_STATE = {
  // ISO timestamp van de nieuwste e-mail die al verwerkt is.
  // Nieuwe IMAP-zoekopdrachten gebruiken dit als ondergrens.
  lastSeenDate: null,
  // Message-IDs die al verstuurd zijn, als extra dedupe-net bovenop lastSeenDate
  // (voorkomt dubbele Telegram-berichten als de klok van de mailserver schuift).
  processedMessageIds: [],
  // Telegram chat-id('s) die berichten moeten ontvangen. Gevuld door /start.
  chatIds: [],
};

const MAX_PROCESSED_IDS = 500;

export async function loadState(path) {
  try {
    const raw = await readFile(path, "utf8");
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch (err) {
    if (err.code === "ENOENT") return { ...DEFAULT_STATE };
    throw err;
  }
}

export async function saveState(path, state) {
  // Houd de dedupe-lijst begrensd zodat het bestand niet blijft groeien.
  if (state.processedMessageIds.length > MAX_PROCESSED_IDS) {
    state.processedMessageIds = state.processedMessageIds.slice(-MAX_PROCESSED_IDS);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), "utf8");
}
