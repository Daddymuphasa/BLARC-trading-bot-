import process from "node:process";
import { loadEnvFile } from "../src/env.js";

loadEnvFile();

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN. Set it before running `npm run bot:commands`.");
  process.exit(1);
}

const commands = [
  { command: "start", description: "Open the home menu" },
  { command: "help", description: "Short guide and tips" },
  { command: "swap", description: "Quick swap (you sign)" },
  { command: "bridge", description: "Bridge USDC between chains" },
  { command: "arc", description: "Arc: swap USDC, EURC, cirBTC" },
  { command: "copy", description: "Follow a trader wallet" },
  { command: "copies", description: "Your copy watches" },
  { command: "watch", description: "Set a price alert" },
  { command: "watchlist", description: "Your price watches" },
  { command: "alerts", description: "Alerts on or off" },
  { command: "connect", description: "Pair your wallet" },
  { command: "create", description: "Create a wallet (seed once)" },
  { command: "disconnect", description: "Forget connected address" },
  { command: "goal", description: "Weekly profit goal" },
  { command: "risk", description: "Pick a risk tier" },
  { command: "auto", description: "Auto-ask to copy trades" },
  { command: "wallet", description: "Save a public address" },
  { command: "wallets", description: "Show saved wallets" },
  { command: "remove_wallet", description: "Remove a saved address" },
  { command: "uncopy", description: "Stop a copy watch" },
  { command: "unwatch", description: "Remove a price watch" },
  { command: "scan", description: "Quick token check" },
  { command: "price", description: "Live DEX price" },
  { command: "settings", description: "Your preferences" },
  { command: "support", description: "Official links" },
  { command: "about", description: "What BLARC is" },
  { command: "fee", description: "Public fee wallet (opt-in)" },
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
