import process from "node:process";
import { loadEnvFile } from "../src/env.js";

loadEnvFile();

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN. Set it before running `npm run bot:commands`.");
  process.exit(1);
}

const commands = [
  { command: "start", description: "Start BLARC onboarding" },
  { command: "help", description: "Show available commands" },
  { command: "scan", description: "Run a token risk checklist" },
  { command: "watch", description: "Add a wallet to your watchlist" },
  { command: "watchlist", description: "Show watched wallets" },
  { command: "unwatch", description: "Remove a watched wallet" },
  { command: "price", description: "Prepare a token price lookup" },
  { command: "alerts", description: "Toggle BLARC alerts" },
  { command: "settings", description: "Show your settings" },
  { command: "support", description: "Official BLARC links" },
  { command: "about", description: "BLARC product status" },
];

const response = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ commands }),
});

const result = await response.json();
if (!result.ok) {
  console.error(result);
  process.exit(1);
}

console.log("BLARC bot commands registered.");
