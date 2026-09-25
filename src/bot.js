import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { buildMarketRiskLines, classifyAddress, findBestPair, formatPairSummary } from "./dexscreener.js";
import { loadEnvFile } from "./env.js";

loadEnvFile();

const token = process.env.TELEGRAM_BOT_TOKEN;
const botUsername = process.env.BLARC_BOT_USERNAME || "theBLARCbot";
const supportUrl = process.env.BLARC_SUPPORT_URL || "https://t.me/BLARCHub";
const updatesUrl = process.env.BLARC_UPDATES_URL || "https://t.me/BLARCUpdates";
const adminIds = new Set(
  (process.env.BLARC_ADMIN_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);

const statePath = path.join(process.cwd(), "data", "blarc-state.json");
let offset = 0;

if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN. Copy .env.example, set your BotFather token, then run `npm start`.");
  process.exit(1);
}

const commands = {
  start: handleStart,
  help: handleHelp,
  scan: handleScan,
  watch: handleWatch,
  watchlist: handleWatchlist,
  unwatch: handleUnwatch,
  price: handlePrice,
  alerts: handleAlerts,
  settings: handleSettings,
  support: handleSupport,
  about: handleAbout,
  broadcast: handleBroadcast,
};

async function main() {
  console.log(`BLARC bot polling as @${botUsername}`);
  await ensureState();

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

async function handleUpdate(update) {
  const message = update.message;
  if (!message?.chat?.id || !message.text) {
    return;
  }

  const parsed = parseCommand(message.text);
  if (!parsed) {
    await sendMessage(message.chat.id, "Send /help to see what BLARC can do right now.");
    return;
  }

  const handler = commands[parsed.name];
  if (!handler) {
    await sendMessage(message.chat.id, `Unknown command: /${parsed.name}\n\nSend /help for available commands.`);
    return;
  }

  await handler(message, parsed.args);
}

function parseCommand(text) {
  if (!text.startsWith("/")) {
    return null;
  }

  const [rawCommand, ...rest] = text.trim().split(/\s+/);
  const name = rawCommand.slice(1).split("@")[0].toLowerCase();
  return { name, args: rest };
}

async function handleStart(message) {
  const name = escapeHtml(message.from?.first_name || "trader");
  await upsertChat(message.chat.id, { alerts: true });
  await sendMessage(
    message.chat.id,
    [
      `Welcome to <b>BLARC</b>, ${name}.`,
      "",
      "This MVP is live in safe mode: token scans, wallet watchlists, alerts settings, support links, and product onboarding.",
      "",
      "<b>Quick commands</b>",
      "/scan &lt;contract&gt; - run token and market risk checks",
      "/watch &lt;wallet&gt; - add a wallet to your watchlist",
      "/watchlist - view watched wallets",
      "/price <token> - lookup live DEX price",
      "/settings - view your bot settings",
      "/support - official BLARC support links",
      "",
      "BLARC will never ask for seed phrases or private keys.",
    ].join("\n"),
  );
}

async function handleHelp(message) {
  await sendMessage(
    message.chat.id,
    [
      "<b>BLARC Commands</b>",
      "/start - onboarding",
      "/scan &lt;contract&gt; - token and market risk checks",
      "/watch &lt;wallet&gt; - save wallet to watch",
      "/unwatch &lt;wallet&gt; - remove wallet",
      "/watchlist - list watched wallets",
      "/price <token> - live DEX price lookup",
      "/alerts on|off - toggle BLARC alerts",
      "/settings - current preferences",
      "/support - official support links",
      "/about - BLARC product status",
    ].join("\n"),
  );
}

async function handleScan(message, args) {
  const target = args[0];
  if (!target) {
    await sendMessage(message.chat.id, "Usage: /scan &lt;contract-address&gt;");
    return;
  }

  const scan = await buildTokenScan(target);
  await sendMessage(
    message.chat.id,
    [
      `<b>BLARC Token Scan</b>`,
      `<code>${escapeHtml(target)}</code>`,
      "",
      scan.lines.join("\n"),
      "",
      `<b>Verdict:</b> ${scan.verdict}`,
      "",
      "MVP note: this is not an on-chain audit. Tax, holder distribution, honeypot simulation, and owner controls still need dedicated adapters before trading.",
    ].join("\n"),
  );
}

async function handleWatch(message, args) {
  const wallet = args[0];
  if (!wallet) {
    await sendMessage(message.chat.id, "Usage: /watch &lt;wallet-address&gt;");
    return;
  }

  const validation = validateAddress(wallet);
  if (!validation.valid) {
    await sendMessage(message.chat.id, `That does not look like a supported wallet address yet.\nReason: ${validation.reason}`);
    return;
  }

  const state = await loadState();
  const chat = ensureChatState(state, message.chat.id);
  if (!chat.watchlist.includes(wallet)) {
    if (chat.watchlist.length >= 20) {
      await sendMessage(message.chat.id, "Watchlist limit reached. Remove one with /unwatch &lt;wallet&gt; before adding more.");
      return;
    }
    chat.watchlist.push(wallet);
    await saveState(state);
  }

  await sendMessage(message.chat.id, `Watching <code>${escapeHtml(wallet)}</code>\nUse /watchlist to view saved wallets.`);
}

async function handleWatchlist(message) {
  const state = await loadState();
  const chat = ensureChatState(state, message.chat.id);

  if (chat.watchlist.length === 0) {
    await sendMessage(message.chat.id, "Your BLARC watchlist is empty. Add one with /watch &lt;wallet-address&gt;.");
    return;
  }

  const wallets = chat.watchlist.map((wallet, index) => `${index + 1}. <code>${escapeHtml(wallet)}</code>`);
  await sendMessage(message.chat.id, [`<b>Your watched wallets</b>`, "", ...wallets].join("\n"));
}

async function handleUnwatch(message, args) {
  const wallet = args[0];
  if (!wallet) {
    await sendMessage(message.chat.id, "Usage: /unwatch &lt;wallet-address&gt;");
    return;
  }

  const state = await loadState();
  const chat = ensureChatState(state, message.chat.id);
  const before = chat.watchlist.length;
  chat.watchlist = chat.watchlist.filter((item) => item.toLowerCase() !== wallet.toLowerCase());
  await saveState(state);

  await sendMessage(
    message.chat.id,
    before === chat.watchlist.length ? "That wallet was not on your watchlist." : `Removed <code>${escapeHtml(wallet)}</code>.`,
  );
}

async function handlePrice(message, args) {
  const target = args.join(" ");
  if (!target) {
    await sendMessage(message.chat.id, "Usage: /price &lt;symbol-or-contract&gt;");
    return;
  }

  await sendMessage(message.chat.id, "Checking DexScreener for the best active pair...");

  try {
    const pair = await findBestPair(target);
    if (!pair) {
      await sendMessage(message.chat.id, `No active DexScreener pair found for <code>${escapeHtml(target)}</code>.`);
      return;
    }

    await sendMessage(
      message.chat.id,
      [`<b>BLARC Price Lookup</b>`, `<code>${escapeHtml(target)}</code>`, "", ...formatPairSummary(pair)].join("\n"),
    );
  } catch (error) {
    await sendMessage(
      message.chat.id,
      [
        `<b>Price Lookup Failed</b>`,
        `DexScreener lookup failed for <code>${escapeHtml(target)}</code>.`,
        "",
        `Reason: ${escapeHtml(error.message)}`,
      ].join("\n"),
    );
  }
}

async function buildTokenScan(target) {
  const validation = validateAddress(target);
  const lines = [];
  let score = 0;

  if (validation.valid) {
    lines.push(`✅ Format: ${validation.chain} address pattern`);
    score += 1;
  } else {
    lines.push(`⚠️ Format: ${escapeHtml(validation.reason)}`);
  }

  if (/^0x0{8,}/i.test(target)) {
    lines.push("⚠️ Contract has an unusual zero-heavy prefix");
  } else {
    lines.push("✅ No obvious zero-prefix anomaly");
    score += 1;
  }

  if (target.length >= 32) {
    lines.push("✅ Address length is plausible");
    score += 1;
  } else {
    lines.push("⚠️ Address is shorter than expected");
  }

  try {
    const pair = validation.valid ? await findBestPair(target) : null;
    const marketRisk = buildMarketRiskLines(pair);
    lines.push(...marketRisk.lines);
    score += marketRisk.score;
  } catch (error) {
    lines.push(`⚠️ Market data: DexScreener lookup failed (${escapeHtml(error.message)})`);
  }

  lines.push("⏳ Honeypot simulation: pending adapter");
  lines.push("⏳ Ownership and tax check: pending adapter");

  let verdict = "High caution. Risk checks did not pass cleanly.";
  if (score >= 7) {
    verdict = "Looks healthier by available checks. Still verify contract risk before trading.";
  } else if (score >= 4) {
    verdict = "Mixed signals. Use small size and wait for deeper risk adapters.";
  }

  return { lines, verdict };
}

function validateAddress(value) {
  return classifyAddress(value);
}

async function handleAlerts(message, args) {
  const mode = args[0]?.toLowerCase();
  if (!["on", "off"].includes(mode)) {
    await sendMessage(message.chat.id, "Usage: /alerts on or /alerts off");
    return;
  }

  const state = await loadState();
  const chat = ensureChatState(state, message.chat.id);
  chat.alerts = mode === "on";
  await saveState(state);
  await sendMessage(message.chat.id, `BLARC alerts are now <b>${mode.toUpperCase()}</b>.`);
}

async function handleSettings(message) {
  const state = await loadState();
  const chat = ensureChatState(state, message.chat.id);
  await sendMessage(
    message.chat.id,
    [
      "<b>BLARC Settings</b>",
      `Alerts: <b>${chat.alerts ? "ON" : "OFF"}</b>`,
      `Watched wallets: <b>${chat.watchlist.length}</b>/20`,
      "",
      "Change alerts with /alerts on or /alerts off.",
    ].join("\n"),
  );
}

async function handleSupport(message) {
  await sendMessage(
    message.chat.id,
    [
      "<b>Official BLARC Links</b>",
      `Support hub: ${escapeHtml(supportUrl)}`,
      `Updates: ${escapeHtml(updatesUrl)}`,
      "",
      "Security reminder: BLARC support will never ask for your seed phrase, private key, or Telegram login code.",
    ].join("\n"),
    {
      disable_web_page_preview: true,
    },
  );
}

async function handleAbout(message) {
  await sendMessage(
    message.chat.id,
    [
      "<b>About BLARC</b>",
      "BLARC is being built as an Arc-native Telegram command center for DeFi discovery, monitoring, and eventually guarded trading workflows.",
      "",
      "Current bot status: safe MVP.",
      "Live trading, private-key custody, and copy-trading execution are intentionally not enabled yet.",
    ].join("\n"),
  );
}

async function handleBroadcast(message, args) {
  if (!adminIds.has(String(message.from?.id))) {
    await sendMessage(message.chat.id, "Broadcast is restricted to BLARC admins.");
    return;
  }

  const text = args.join(" ");
  if (!text) {
    await sendMessage(message.chat.id, "Usage: /broadcast &lt;message&gt;");
    return;
  }

  const state = await loadState();
  const chatIds = Object.keys(state.chats);
  let sent = 0;

  for (const chatId of chatIds) {
    try {
      await sendMessage(chatId, `<b>BLARC Update</b>\n\n${escapeHtml(text)}`);
      sent += 1;
      await sleep(60);
    } catch (error) {
      console.error(`Broadcast failed for ${chatId}:`, error.message);
    }
  }

  await sendMessage(message.chat.id, `Broadcast sent to ${sent}/${chatIds.length} chats.`);
}

async function telegram(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!data.ok) {
    throw new Error(data.description || `Telegram ${method} failed`);
  }

  return data.result;
}

async function sendMessage(chatId, text, options = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...options,
  });
}

async function upsertChat(chatId, defaults = {}) {
  const state = await loadState();
  const chat = ensureChatState(state, chatId);
  Object.assign(chat, { ...defaults, ...chat });
  await saveState(state);
}

function ensureChatState(state, chatId) {
  const key = String(chatId);
  state.chats[key] ||= {
    alerts: true,
    watchlist: [],
  };

  state.chats[key].watchlist ||= [];
  state.chats[key].alerts = state.chats[key].alerts !== false;
  return state.chats[key];
}

async function ensureState() {
  await mkdir(path.dirname(statePath), { recursive: true });
  try {
    await readFile(statePath, "utf8");
  } catch {
    await saveState({ chats: {} });
  }
}

async function loadState() {
  await ensureState();
  const raw = await readFile(statePath, "utf8");
  return JSON.parse(raw);
}

async function saveState(state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

main();
