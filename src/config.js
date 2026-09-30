import path from "node:path";
import process from "node:process";
import { loadEnvFile } from "./env.js";

loadEnvFile();

export const token = process.env.TELEGRAM_BOT_TOKEN;
export const botUsername = process.env.BLARC_BOT_USERNAME || "theBLARCbot";
export const supportUrl = process.env.BLARC_SUPPORT_URL || "https://t.me/BLARCHub";
export const updatesUrl = process.env.BLARC_UPDATES_URL || "https://t.me/BLARCUpdates";
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
