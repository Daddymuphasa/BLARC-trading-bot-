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
  { command: "connect", description: "Pair your own wallet with WalletConnect" },
  { command: "disconnect", description: "Forget the connected public address" },
  { command: "fee", description: "Show the 1% swap fee wallet" },
  { command: "swap", description: "Swap with the 1% fee inside the transaction" },
  { command: "wallet", description: "Add a read-only wallet" },
  { command: "wallets", description: "Show saved wallets" },
  { command: "remove_wallet", description: "Remove a saved wallet" },
  { command: "scan", description: "Run a token risk checklist" },
  { command: "watch", description: "Watch a token and set a USD target" },
  { command: "watchlist", description: "Show token price watches" },
  { command: "unwatch", description: "Remove a token price watch" },
  { command: "price", description: "Look up a live DEX price" },
  { command: "alerts", description: "Turn price alert delivery on or off" },
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
