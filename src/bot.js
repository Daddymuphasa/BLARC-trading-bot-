import process from "node:process";
import { startPriceAlertLoop } from "./alerts.js";
import { handleUpdate } from "./commands.js";
import { botUsername, token } from "./config.js";
import { ensureState } from "./state.js";
import { sleep, telegram } from "./telegram.js";

if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN. Copy .env.example, set your BotFather token, then run `npm start`.");
  process.exit(1);
}

let offset = 0;

async function main() {
  console.log(`BLARC bot polling as @${botUsername}`);
  await ensureState();
  startPriceAlertLoop();

  while (true) {
    try {
      const updates = await telegram("getUpdates", {
        allowed_updates: ["message"],
        offset,
        timeout: 25,
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        await handleUpdate(update);
      }
    } catch (error) {
      console.error("Polling error:", error.message);
      await sleep(2500);
    }
  }
}

main();
