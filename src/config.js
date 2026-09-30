import path from "node:path";
import process from "node:process";
import { loadEnvFile } from "./env.js";

loadEnvFile();

export const token = process.env.TELEGRAM_BOT_TOKEN;
export const botUsername = process.env.BLARC_BOT_USERNAME || "theBLARCbot";
export const supportUrl = process.env.BLARC_SUPPORT_URL || "https://t.me/BLARCHub";
export const updatesUrl = process.env.BLARC_UPDATES_URL || "https://t.me/BLARCUpdates";
export const twitterUrl = String(process.env.BLARC_TWITTER_URL || "https://x.com/blARCthedawg").trim();
export const adminIds = new Set(
  (process.env.BLARC_ADMIN_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);

export const statePath = path.join(process.cwd(), "data", "blarc-state.json");
export const priceCheckIntervalMs = 60_000;
export const priceCheckGapMs = 400;
export const maxPriceWatches = 20;

export const copyPollIntervalMs = 15_000;
export const maxCopyWatches = 10;

export function evmRpcUrl() {
  return String(process.env.BLARC_EVM_RPC_URL || "").trim();
}

export function solanaRpcUrl() {
  return String(process.env.BLARC_SOLANA_RPC_URL || "").trim();
}

