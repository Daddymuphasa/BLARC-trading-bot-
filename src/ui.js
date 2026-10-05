import { supportUrl, twitterUrl, updatesUrl } from "./config.js";
import { formatCopyStatus, handleAuto, handleCopy, handleGoal, handleRisk, handleUncopy } from "./copy.js";
import { handleCreate } from "./createCommand.js";
import { handleAlerts, handleUnwatch, handleWatch } from "./alerts.js";
import { readState } from "./state.js";
import { executeSwap, knownTokenSymbols } from "./swap.js";
import {
  answerCallbackQuery,
  btn,
  editMessageText,
  escapeHtml,
  inlineKeyboard,
  sendGuide,
  sendMessage,
} from "./telegram.js";
import {
  SOLANA_SENTINEL_CHAIN_ID,
  chainIdNumber,
  looksLikeSecretMaterial,
  sanitizeWallet,
} from "./wallet.js";

const AMOUNT_PRESETS = ["10", "50", "100", "250"];
const GOAL_PRESETS = ["10", "25", "40", "50"];
const PROMPT_MS = 15 * 60 * 1000;

/** @type {Map<string, { kind: string, draft?: object, expires: number }>} */
const prompts = new Map();
/** @type {Map<string, number>} */
const screenMessageIds = new Map();

export function clearUiPrompt(chatId) {
  prompts.delete(String(chatId));
}

export function hasUiPrompt(chatId) {
  const entry = prompts.get(String(chatId));
  if (!entry) {
    return false;
  }
  if (Date.now() > entry.expires) {
    prompts.delete(String(chatId));
    return false;
  }
  return true;
}

function setPrompt(chatId, kind, draft = {}) {
  prompts.set(String(chatId), { kind, draft, expires: Date.now() + PROMPT_MS });
}

function takePrompt(chatId) {
  const key = String(chatId);
  const entry = prompts.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() > entry.expires) {
    prompts.delete(key);
    return null;
  }
  prompts.delete(key);
  return entry;
}

function peekPrompt(chatId) {
  const key = String(chatId);
  const entry = prompts.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() > entry.expires) {
    prompts.delete(key);
    return null;
  }
  return entry;
}

function navRow() {
  return [btn("⬅️ Back", "ui:back"), btn("🏠 Home", "ui:home")];
}

function homeKeyboard() {
  return inlineKeyboard([
    [btn("🔄 Swap", "ui:swap"), btn("📋 Copy trade", "ui:copy")],
    [btn("🔔 Price alerts", "ui:alerts"), btn("👀 Watchlist", "ui:watchlist")],
    [btn("🔗 Connect wallet", "ui:connect"), btn("🆕 Create wallet", "ui:create")],
    [btn("🎯 Goal", "ui:goal"), btn("⚖️ Risk", "ui:risk")],
    [btn("⚙️ Auto", "ui:auto"), btn("💼 Wallets", "ui:wallets")],
    [btn("📖 Guide", "ui:guide"), btn("💬 Support", "ui:support")],
  ]);
}

function homeText(name) {
  const who = name ? `, ${escapeHtml(name)}` : "";
  return [
    `<b>BLARC</b>${who}`,
    "Tap a button below. You sign every swap in your own wallet.",
  ].join("\n");
}

export async function showHome(chatId, options = {}) {
  clearUiPrompt(chatId);
  const text = homeText(options.name);
  return showScreen(chatId, text, homeKeyboard(), options);
}

async function showScreen(chatId, text, replyMarkup, options = {}) {
  const key = String(chatId);
  const messageId = options.messageId ?? screenMessageIds.get(key);
  if (messageId && options.edit !== false) {
    try {
      const edited = await editMessageText(chatId, messageId, text, { reply_markup: replyMarkup });
      screenMessageIds.set(key, edited.message_id || messageId);
      return edited;
    } catch (error) {
      const msg = String(error?.message || "");
      if (/message is not modified/i.test(msg)) {
        return { message_id: messageId, chat: { id: chatId } };
      }
    }
  }
  const sent = await sendMessage(chatId, text, { reply_markup: replyMarkup });
  if (sent?.message_id) {
    screenMessageIds.set(key, sent.message_id);
  }
  return sent;
}

export async function handleUiCallback(callback) {
  const data = String(callback?.data || "");
  if (!data.startsWith("ui:")) {
    return false;
  }

  const chatId = callback?.message?.chat?.id;
  const messageId = callback?.message?.message_id;
  if (!chatId) {
    await answerCallbackQuery(callback?.id, "Closed");
    return true;
  }

  if (messageId) {
    screenMessageIds.set(String(chatId), messageId);
  }

  const parts = data.split(":");
  const action = parts[1] || "";

  try {
    await routeUi(chatId, action, parts.slice(2), {
      callbackId: callback.id,
      messageId,
      from: callback.from,
      message: callback.message,
    });
  } catch (error) {
    console.error("UI callback failed:", error.message);
    await answerCallbackQuery(callback.id, "Something went wrong");
    await showScreen(
      chatId,
      "Something went wrong. Tap Home to try again.",
      inlineKeyboard([navRow()]),
      { messageId },
    );
  }
  return true;
}

async function routeUi(chatId, action, args, ctx) {
  switch (action) {
    case "home":
      await answerCallbackQuery(ctx.callbackId);
      await showHome(chatId, { messageId: ctx.messageId, name: ctx.from?.first_name });
      return;
    case "back":
      await answerCallbackQuery(ctx.callbackId);
      await showHome(chatId, { messageId: ctx.messageId, name: ctx.from?.first_name });
      return;
    case "swap":
      await answerCallbackQuery(ctx.callbackId);
      await openSwap(chatId, ctx.messageId);
      return;
    case "sw":
      await handleSwapAction(chatId, args, ctx);
      return;
    case "copy":
      await answerCallbackQuery(ctx.callbackId);
      await openCopy(chatId, ctx.messageId);
      return;
    case "cp":
      await handleCopyAction(chatId, args, ctx);
      return;
    case "alerts":
      await answerCallbackQuery(ctx.callbackId);
      await openAlerts(chatId, ctx.messageId);
      return;
    case "al":
      await handleAlertsAction(chatId, args, ctx);
      return;
    case "watchlist":
      await answerCallbackQuery(ctx.callbackId);
      await openWatchlist(chatId, ctx.messageId);
      return;
    case "wl":
      await handleWatchlistAction(chatId, args, ctx);
      return;
    case "connect":
      await answerCallbackQuery(ctx.callbackId, "Opening connect…");
      clearUiPrompt(chatId);
      await runAsCommand(chatId, ctx.from, "connect");
      await showScreen(chatId, "Scan the QR in your wallet app, then come back here.", inlineKeyboard([navRow()]));
      return;
    case "create":
      await answerCallbackQuery(ctx.callbackId, "Opening create…");
      clearUiPrompt(chatId);
      await runAsCommand(chatId, ctx.from, "create");
      return;
    case "disconnect":
      await answerCallbackQuery(ctx.callbackId);
      await runAsCommand(chatId, ctx.from, "disconnect");
      await showHome(chatId, { name: ctx.from?.first_name });
      return;
    case "goal":
      await answerCallbackQuery(ctx.callbackId);
      await openGoal(chatId, ctx.messageId);
      return;
    case "go":
      await handleGoalAction(chatId, args, ctx);
      return;
    case "risk":
      await answerCallbackQuery(ctx.callbackId);
      await openRisk(chatId, ctx.messageId);
      return;
    case "rk":
      await handleRiskAction(chatId, args, ctx);
      return;
    case "auto":
      await answerCallbackQuery(ctx.callbackId);
      await openAuto(chatId, ctx.messageId);
      return;
    case "au":
      await handleAutoAction(chatId, args, ctx);
      return;
    case "wallets":
      await answerCallbackQuery(ctx.callbackId);
      await openWallets(chatId, ctx.messageId);
      return;
    case "wa":
      await handleWalletsAction(chatId, args, ctx);
      return;
    case "guide":
      await answerCallbackQuery(ctx.callbackId);
      await openGuide(chatId, ctx.messageId);
      return;
    case "support":
      await answerCallbackQuery(ctx.callbackId);
      await openSupport(chatId, ctx.messageId);
      return;
    case "about":
      await answerCallbackQuery(ctx.callbackId);
      await openAbout(chatId, ctx.messageId);
      return;
    case "scan":
      await answerCallbackQuery(ctx.callbackId);
      await openScan(chatId, ctx.messageId);
      return;
    case "price":
      await answerCallbackQuery(ctx.callbackId);
      await openPrice(chatId, ctx.messageId);
      return;
    case "settings":
      await answerCallbackQuery(ctx.callbackId);
      await openSettings(chatId, ctx.messageId);
      return;
    default:
      await answerCallbackQuery(ctx.callbackId, "Unknown button");
      await showHome(chatId, { messageId: ctx.messageId, name: ctx.from?.first_name });
  }
}

function fakeMessage(chatId, from, text = "/ui") {
  return {
    chat: { id: chatId },
    from: from || { id: 0 },
    text,
  };
}

async function runAsCommand(chatId, from, name, args = []) {
  const message = fakeMessage(chatId, from);
  if (name === "create") {
    await handleCreate(message);
    return;
  }
  const mod = await import("./commands.js");
  if (name === "connect" && typeof mod.handleConnect === "function") {
    await mod.handleConnect(message, args);
    return;
  }
  if (name === "disconnect" && typeof mod.handleDisconnect === "function") {
    await mod.handleDisconnect(message);
  }
}

async function connectedWallet(chatId) {
  const state = await readState();
  return sanitizeWallet(state.chats?.[String(chatId)]?.wallet);
}

function tokenChoices(wallet) {
  if (!wallet) {
    return ["ETH", "USDC", "USDT"];
  }
  if (wallet.chainId === SOLANA_SENTINEL_CHAIN_ID) {
    return ["SOL", "USDC", "USDT"];
  }
  const id = chainIdNumber(wallet.chainId);
  return knownTokenSymbols(id);
}

function chunkButtons(labels, prefix) {
  const rows = [];
  for (let i = 0; i < labels.length; i += 3) {
    rows.push(labels.slice(i, i + 3).map((label) => btn(label, `${prefix}${label}`)));
  }
  return rows;
}

async function openSwap(chatId, messageId) {
  clearUiPrompt(chatId);
  const wallet = await connectedWallet(chatId);
  if (!wallet) {
    await showScreen(
      chatId,
      "<b>Quick swap</b>\nConnect your wallet first. You sign every swap.",
      inlineKeyboard([[btn("🔗 Connect wallet", "ui:connect")], navRow()]),
      { messageId },
    );
    return;
  }

  const tokens = tokenChoices(wallet);
  const chainLabel = wallet.chainId === SOLANA_SENTINEL_CHAIN_ID ? "Solana" : escapeHtml(wallet.chainId);
  await showScreen(
    chatId,
    [
      "<b>Quick swap</b>",
      `Wallet: <code>${escapeHtml(wallet.address)}</code>`,
      `Chain: <code>${chainLabel}</code>`,
      "",
      "What are you selling?",
    ].join("\n"),
    inlineKeyboard([
      ...chunkButtons(tokens, "ui:sw:sell:"),
      [btn("✏️ Custom token", "ui:sw:sellcustom")],
      navRow(),
    ]),
    { messageId },
  );
}

async function handleSwapAction(chatId, args, ctx) {
  const step = args[0] || "";
  const value = args.slice(1).join(":");

  if (step === "sellcustom") {
    await answerCallbackQuery(ctx.callbackId);
    setPrompt(chatId, "swap_sell", {});
    await showScreen(
      chatId,
      "<b>Quick swap</b>\nSend the sell token symbol or contract address.",
      inlineKeyboard([navRow()]),
      { messageId: ctx.messageId },
    );
    return;
  }
  if (step === "buycustom") {
    const prompt = peekPrompt(chatId);
    const draft = prompt?.kind === "swap_draft" ? prompt.draft : {};
    await answerCallbackQuery(ctx.callbackId);
    setPrompt(chatId, "swap_buy", draft);
    await showScreen(
      chatId,
      "<b>Quick swap</b>\nSend the buy token symbol or contract address.",
      inlineKeyboard([navRow()]),
      { messageId: ctx.messageId },
    );
    return;
  }
  if (step === "sell" && value) {
    await answerCallbackQuery(ctx.callbackId);
    await showBuyStep(chatId, { sell: value }, ctx.messageId);
    return;
  }
  if (step === "buy" && value) {
    const prompt = peekPrompt(chatId);
    const draft = { ...(prompt?.kind === "swap_draft" ? prompt.draft : {}), buy: value };
    await answerCallbackQuery(ctx.callbackId);
    await showAmountStep(chatId, draft, ctx.messageId);
    return;
  }
  if (step === "amt" && value === "custom") {
    const prompt = peekPrompt(chatId);
    const draft = prompt?.kind === "swap_draft" ? prompt.draft : {};
    await answerCallbackQuery(ctx.callbackId);
    setPrompt(chatId, "swap_amount", draft);
    await showScreen(
      chatId,
      "<b>Quick swap</b>\nSend the amount as a number, like <code>25</code>.",
      inlineKeyboard([navRow()]),
      { messageId: ctx.messageId },
    );
    return;
  }
  if (step === "amt" && value) {
    const prompt = peekPrompt(chatId);
    const draft = { ...(prompt?.kind === "swap_draft" ? prompt.draft : {}), amount: value };
    await answerCallbackQuery(ctx.callbackId);
    await showConfirmStep(chatId, draft, ctx.messageId);
    return;
  }
  if (step === "go") {
    const prompt = peekPrompt(chatId);
    const draft = prompt?.kind === "swap_draft" ? prompt.draft : null;
    if (!draft?.sell || !draft?.buy || !draft?.amount) {
      await answerCallbackQuery(ctx.callbackId, "Start the swap again");
      await openSwap(chatId, ctx.messageId);
      return;
    }
    await answerCallbackQuery(ctx.callbackId, "Preparing swap…");
    clearUiPrompt(chatId);
    const wallet = await connectedWallet(chatId);
    if (!wallet) {
      await showScreen(
        chatId,
        "No wallet connected. Connect first.",
        inlineKeyboard([[btn("🔗 Connect wallet", "ui:connect")], navRow()]),
        { messageId: ctx.messageId },
      );
      return;
    }
    await showScreen(
      chatId,
      [
        "<b>Quick swap</b>",
        "Asking your wallet to sign…",
        `Sell: <b>${escapeHtml(draft.amount)} ${escapeHtml(draft.sell)}</b>`,
        `Buy: <b>${escapeHtml(draft.buy)}</b>`,
      ].join("\n"),
      inlineKeyboard([navRow()]),
      { messageId: ctx.messageId },
    );
    const reply = await executeSwap({
      chatId,
      wallet,
      amount: draft.amount,
      tokenIn: draft.sell,
      tokenOut: draft.buy,
    });
    await sendMessage(chatId, reply, { reply_markup: homeKeyboard() });
    return;
  }
  if (step === "cancel") {
    await answerCallbackQuery(ctx.callbackId, "Cancelled");
    clearUiPrompt(chatId);
    await showHome(chatId, { messageId: ctx.messageId, name: ctx.from?.first_name });
    return;
  }

  await answerCallbackQuery(ctx.callbackId);
  await openSwap(chatId, ctx.messageId);
}

async function showBuyStep(chatId, draft, messageId) {
  setPrompt(chatId, "swap_draft", draft);
  const wallet = await connectedWallet(chatId);
  const tokens = tokenChoices(wallet).filter((t) => t.toLowerCase() !== String(draft.sell).toLowerCase());
  await showScreen(
    chatId,
    [
      "<b>Quick swap</b>",
      `Selling: <b>${escapeHtml(draft.sell)}</b>`,
      "",
      "What do you want to buy?",
    ].join("\n"),
    inlineKeyboard([
      ...chunkButtons(tokens, "ui:sw:buy:"),
      [btn("✏️ Custom token", "ui:sw:buycustom")],
      [btn("⬅️ Back", "ui:swap"), btn("🏠 Home", "ui:home")],
    ]),
    { messageId },
  );
}

async function showAmountStep(chatId, draft, messageId) {
  setPrompt(chatId, "swap_draft", draft);
  await showScreen(
    chatId,
    [
      "<b>Quick swap</b>",
      `Sell: <b>${escapeHtml(draft.sell)}</b>`,
      `Buy: <b>${escapeHtml(draft.buy)}</b>`,
      "",
      "How much are you selling?",
    ].join("\n"),
    inlineKeyboard([
      AMOUNT_PRESETS.slice(0, 2).map((a) => btn(a, `ui:sw:amt:${a}`)),
      AMOUNT_PRESETS.slice(2).map((a) => btn(a, `ui:sw:amt:${a}`)),
      [btn("✏️ Custom amount", "ui:sw:amt:custom")],
      [btn("⬅️ Back", "ui:swap"), btn("🏠 Home", "ui:home")],
    ]),
    { messageId },
  );
}

async function showConfirmStep(chatId, draft, messageId) {
  setPrompt(chatId, "swap_draft", draft);
  const wallet = await connectedWallet(chatId);
  const chainLabel =
    wallet?.chainId === SOLANA_SENTINEL_CHAIN_ID ? "Solana" : escapeHtml(wallet?.chainId || "—");
  await showScreen(
    chatId,
    [
      "<b>Confirm swap</b>",
      wallet ? `Wallet: <code>${escapeHtml(wallet.address)}</code>` : "Wallet: not connected",
      `Chain: <code>${chainLabel}</code>`,
      `Sell: <b>${escapeHtml(draft.amount)} ${escapeHtml(draft.sell)}</b>`,
      `Buy: <b>${escapeHtml(draft.buy)}</b>`,
      "",
      "You sign in your own wallet. Tap Confirm to continue.",
    ].join("\n"),
    inlineKeyboard([
      [btn("✅ Confirm", "ui:sw:go"), btn("❌ Cancel", "ui:sw:cancel")],
      navRow(),
    ]),
    { messageId },
  );
}

async function openCopy(chatId, messageId) {
  clearUiPrompt(chatId);
  const state = await readState();
  const chat = state.chats?.[String(chatId)];
  const text = [
    formatCopyStatus(chat, { list: true }),
    "",
    "Paste a public wallet to follow a trader. Auto still asks you to sign.",
  ].join("\n");
  await showScreen(
    chatId,
    text,
    inlineKeyboard([
      [btn("➕ Add trader", "ui:cp:add"), btn("📋 My copies", "ui:cp:list")],
      [btn("⚙️ Auto", "ui:auto"), btn("🛑 Stop one", "ui:cp:stop")],
      navRow(),
    ]),
    { messageId },
  );
}

async function handleCopyAction(chatId, args, ctx) {
  const step = args[0] || "";
  if (step === "add") {
    await answerCallbackQuery(ctx.callbackId);
    setPrompt(chatId, "copy_wallet", {});
    await showScreen(
      chatId,
      "<b>Copy trade</b>\nSend the public wallet address to watch.\nOne address only. Seeds are rejected.",
      inlineKeyboard([navRow()]),
      { messageId: ctx.messageId },
    );
    return;
  }
  if (step === "list") {
    await answerCallbackQuery(ctx.callbackId);
    await openCopy(chatId, ctx.messageId);
    return;
  }
  if (step === "stop") {
    await answerCallbackQuery(ctx.callbackId);
    const state = await readState();
    const watches = state.chats?.[String(chatId)]?.copyWatches || [];
    if (watches.length === 0) {
      await showScreen(
        chatId,
        "No copy watches yet.",
        inlineKeyboard([[btn("➕ Add trader", "ui:cp:add")], navRow()]),
        { messageId: ctx.messageId },
      );
      return;
    }
    const rows = watches.map((watch, index) => [
      btn(`Stop ${shortAddr(watch.address)}`, `ui:cp:uncopy:${index}`),
    ]);
    await showScreen(
      chatId,
      "<b>Stop watching</b>\nTap a wallet to stop.",
      inlineKeyboard([...rows, navRow()]),
      { messageId: ctx.messageId },
    );
    return;
  }
  if (step === "uncopy") {
    const index = Number(args[1]);
    const state = await readState();
    const watches = state.chats?.[String(chatId)]?.copyWatches || [];
    const watch = watches[index];
    await answerCallbackQuery(ctx.callbackId, watch ? "Stopped" : "Gone");
    if (watch) {
      await handleUncopy(fakeMessage(chatId, ctx.from), [watch.address]);
    }
    await openCopy(chatId, ctx.messageId);
    return;
  }
  await answerCallbackQuery(ctx.callbackId);
  await openCopy(chatId, ctx.messageId);
}

function shortAddr(address) {
  const value = String(address || "");
  if (value.length <= 12) {
    return value;
  }
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

async function openAlerts(chatId, messageId) {
  clearUiPrompt(chatId);
  const state = await readState();
  const chat = state.chats?.[String(chatId)];
  const on = chat ? chat.alerts !== false : true;
  const count = chat?.priceWatches?.length || 0;
  await showScreen(
    chatId,
    [
      "<b>Price alerts</b>",
      `Delivery: <b>${on ? "ON" : "OFF"}</b>`,
      `Watches: <b>${count}</b>`,
      "",
      "Get one message when price crosses your target. No trade is placed.",
    ].join("\n"),
    inlineKeyboard([
      [btn("➕ Add alert", "ui:al:add"), btn("👀 Watchlist", "ui:watchlist")],
      [btn(on ? "🔕 Alerts off" : "🔔 Alerts on", on ? "ui:al:off" : "ui:al:on")],
      navRow(),
    ]),
    { messageId },
  );
}

async function handleAlertsAction(chatId, args, ctx) {
  const step = args[0] || "";
  if (step === "on" || step === "off") {
    await answerCallbackQuery(ctx.callbackId, step === "on" ? "Alerts on" : "Alerts off");
    await handleAlerts(fakeMessage(chatId, ctx.from), [step]);
    await openAlerts(chatId, ctx.messageId);
    return;
  }
  if (step === "add") {
    await answerCallbackQuery(ctx.callbackId);
    setPrompt(chatId, "watch_token", {});
    await showScreen(
      chatId,
      "<b>New alert</b>\nSend a token symbol or contract address.",
      inlineKeyboard([navRow()]),
      { messageId: ctx.messageId },
    );
    return;
  }
  if (step === "dir") {
    const dir = args[1];
    const prompt = peekPrompt(chatId);
    const draft = prompt?.kind === "watch_draft" ? prompt.draft : {};
    if (!draft.token || (dir !== "above" && dir !== "below")) {
      await answerCallbackQuery(ctx.callbackId, "Start again");
      await openAlerts(chatId, ctx.messageId);
      return;
    }
    await answerCallbackQuery(ctx.callbackId);
    setPrompt(chatId, "watch_price", { ...draft, dir });
    await showScreen(
      chatId,
      `<b>New alert</b>\nToken: <b>${escapeHtml(draft.token)}</b>\nDirection: <b>${dir}</b>\n\nSend the USD price, like <code>0.00002</code>.`,
      inlineKeyboard([navRow()]),
      { messageId: ctx.messageId },
    );
    return;
  }
  await answerCallbackQuery(ctx.callbackId);
  await openAlerts(chatId, ctx.messageId);
}

async function openWatchlist(chatId, messageId) {
  clearUiPrompt(chatId);
  const state = await readState();
  const chat = state.chats?.[String(chatId)];
  const watches = chat?.priceWatches || [];
  const on = chat ? chat.alerts !== false : true;

  if (watches.length === 0) {
    await showScreen(
      chatId,
      [
        "<b>Watchlist</b>",
        "No price watches yet.",
        "Add an alert to track a token.",
      ].join("\n"),
      inlineKeyboard([[btn("➕ Add alert", "ui:al:add")], navRow()]),
      { messageId },
    );
    return;
  }

  const lines = watches.map((watch, index) => {
    const label = watch.symbol || watch.query;
    return `${index + 1}. <b>${escapeHtml(label)}</b> · last ${escapeHtml(String(watch.lastPriceUsd ?? "—"))}`;
  });

  const removeRows = watches.slice(0, 8).map((watch, index) => [
    btn(`Remove ${watch.symbol || shortAddr(watch.query)}`, `ui:wl:rm:${index}`),
  ]);

  await showScreen(
    chatId,
    [`<b>Watchlist</b>`, `Alerts: <b>${on ? "ON" : "OFF"}</b>`, "", ...lines].join("\n"),
    inlineKeyboard([[btn("➕ Add alert", "ui:al:add")], ...removeRows, navRow()]),
    { messageId },
  );
}

async function handleWatchlistAction(chatId, args, ctx) {
  if (args[0] === "rm") {
    const index = Number(args[1]);
    const state = await readState();
    const watches = state.chats?.[String(chatId)]?.priceWatches || [];
    const watch = watches[index];
    await answerCallbackQuery(ctx.callbackId, watch ? "Removed" : "Gone");
    if (watch) {
      await handleUnwatch(fakeMessage(chatId, ctx.from), [watch.query || watch.tokenAddress || watch.symbol]);
    }
    await openWatchlist(chatId, ctx.messageId);
    return;
  }
  await answerCallbackQuery(ctx.callbackId);
  await openWatchlist(chatId, ctx.messageId);
}

async function openGoal(chatId, messageId) {
  clearUiPrompt(chatId);
  const state = await readState();
  const goal = state.chats?.[String(chatId)]?.weeklyGoalPercent;
  await showScreen(
    chatId,
    [
      "<b>Weekly goal</b>",
      goal ? `Current: <b>${escapeHtml(String(goal))}%</b>` : "Current: <b>not set</b>",
      "",
      "Pick a weekly profit goal percent. This does not read your balance.",
    ].join("\n"),
    inlineKeyboard([
      GOAL_PRESETS.slice(0, 2).map((g) => btn(`${g}%`, `ui:go:set:${g}`)),
      GOAL_PRESETS.slice(2).map((g) => btn(`${g}%`, `ui:go:set:${g}`)),
      [btn("✏️ Custom", "ui:go:custom"), btn("Off", "ui:go:off")],
      navRow(),
    ]),
    { messageId },
  );
}

async function handleGoalAction(chatId, args, ctx) {
  const step = args[0] || "";
  if (step === "set" && args[1]) {
    await answerCallbackQuery(ctx.callbackId, `Goal ${args[1]}%`);
    await handleGoal(fakeMessage(chatId, ctx.from), [args[1]]);
    await openGoal(chatId, ctx.messageId);
    return;
  }
  if (step === "off") {
    await answerCallbackQuery(ctx.callbackId, "Goal cleared");
    await handleGoal(fakeMessage(chatId, ctx.from), ["off"]);
    await openGoal(chatId, ctx.messageId);
    return;
  }
  if (step === "custom") {
    await answerCallbackQuery(ctx.callbackId);
    setPrompt(chatId, "goal_custom", {});
    await showScreen(
      chatId,
      "<b>Weekly goal</b>\nSend a percent number, like <code>40</code>.",
      inlineKeyboard([navRow()]),
      { messageId: ctx.messageId },
    );
    return;
  }
  await answerCallbackQuery(ctx.callbackId);
  await openGoal(chatId, ctx.messageId);
}

async function openRisk(chatId, messageId) {
  clearUiPrompt(chatId);
  const state = await readState();
  const chat = state.chats?.[String(chatId)];
  const tier = chat?.riskTier;
  const label = tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : "not set";
  await showScreen(
    chatId,
    [
      "<b>Risk tier</b>",
      `Current: <b>${escapeHtml(label)}</b>`,
      chat?.riskMax ? `Size cap: <b>${escapeHtml(chat.riskMax)}</b>` : "",
      "",
      "Used when a copied trade asks you to sign.",
    ]
      .filter(Boolean)
      .join("\n"),
    inlineKeyboard([
      [btn("Low", "ui:rk:set:low"), btn("Average", "ui:rk:set:average")],
      [btn("High", "ui:rk:set:high"), btn("Daredevil", "ui:rk:set:daredevil")],
      navRow(),
    ]),
    { messageId },
  );
}

async function handleRiskAction(chatId, args, ctx) {
  if (args[0] === "set" && args[1]) {
    await answerCallbackQuery(ctx.callbackId, `Risk ${args[1]}`);
    await handleRisk(fakeMessage(chatId, ctx.from), [args[1]]);
    await openRisk(chatId, ctx.messageId);
    return;
  }
  await answerCallbackQuery(ctx.callbackId);
  await openRisk(chatId, ctx.messageId);
}

async function openAuto(chatId, messageId) {
  clearUiPrompt(chatId);
  const state = await readState();
  const watches = state.chats?.[String(chatId)]?.copyWatches || [];
  if (watches.length === 0) {
    await showScreen(
      chatId,
      "<b>Auto copy</b>\nAdd a trader first. Auto still asks your wallet to sign.",
      inlineKeyboard([[btn("➕ Add trader", "ui:cp:add")], navRow()]),
      { messageId },
    );
    return;
  }
  const lines = watches.map((watch, index) => {
    return `${index + 1}. <code>${escapeHtml(shortAddr(watch.address))}</code> · Auto <b>${watch.auto ? "ON" : "OFF"}</b>`;
  });
  const rows = watches.map((watch, index) => [
    btn(
      `${watch.auto ? "Turn off" : "Turn on"} ${shortAddr(watch.address)}`,
      `ui:au:toggle:${index}`,
    ),
  ]);
  await showScreen(
    chatId,
    ["<b>Auto copy</b>", "Auto still asks you to sign. BLARC never holds a key.", "", ...lines].join("\n"),
    inlineKeyboard([...rows, navRow()]),
    { messageId },
  );
}

async function handleAutoAction(chatId, args, ctx) {
  if (args[0] === "toggle") {
    const index = Number(args[1]);
    const state = await readState();
    const watches = state.chats?.[String(chatId)]?.copyWatches || [];
    const watch = watches[index];
    if (!watch) {
      await answerCallbackQuery(ctx.callbackId, "Gone");
      await openAuto(chatId, ctx.messageId);
      return;
    }
    const next = watch.auto ? "off" : "on";
    await answerCallbackQuery(ctx.callbackId, `Auto ${next}`);
    await handleAuto(fakeMessage(chatId, ctx.from), [watch.address, next]);
    await openAuto(chatId, ctx.messageId);
    return;
  }
  await answerCallbackQuery(ctx.callbackId);
  await openAuto(chatId, ctx.messageId);
}

async function openWallets(chatId, messageId) {
  clearUiPrompt(chatId);
  const state = await readState();
  const chat = state.chats?.[String(chatId)];
  const connected = sanitizeWallet(chat?.wallet);
  const lines = [
    "<b>Wallets</b>",
    connected
      ? `Connected: <code>${escapeHtml(connected.address)}</code>\nChain: <code>${escapeHtml(connected.chainId)}</code>`
      : "Connected: <b>none</b>",
    "",
    "Connect to sign swaps. Create shows a seed once after you confirm.",
  ];
  await showScreen(
    chatId,
    lines.join("\n"),
    inlineKeyboard([
      [btn("🔗 Connect", "ui:connect"), btn("🆕 Create", "ui:create")],
      connected ? [btn("Disconnect", "ui:disconnect")] : [],
      navRow(),
    ].filter((row) => row.length)),
    { messageId },
  );
}

async function handleWalletsAction(chatId, args, ctx) {
  await answerCallbackQuery(ctx.callbackId);
  await openWallets(chatId, ctx.messageId);
}

async function openGuide(chatId, messageId) {
  clearUiPrompt(chatId);
  await sendGuide(chatId, "help.jpg", "Tap a button. Paste a wallet. You sign every swap.");
  await showScreen(
    chatId,
    [
      "<b>Guide</b>",
      "• Swap — quick trade, you sign",
      "• Copy trade — follow a public wallet",
      "• Price alerts — one ping at your target",
      "• Connect — pair your own wallet",
      "• Create — new wallet, seed once",
      "",
      "Slash commands still work as shortcuts.",
      "Details: /about · Fee wallet: /fee",
    ].join("\n"),
    inlineKeyboard([
      [btn("🔄 Swap", "ui:swap"), btn("📋 Copy trade", "ui:copy")],
      [btn("ℹ️ About", "ui:about"), btn("🏠 Home", "ui:home")],
    ]),
    { messageId, edit: false },
  );
}

async function openSupport(chatId, messageId) {
  clearUiPrompt(chatId);
  await showScreen(
    chatId,
    [
      "<b>Support</b>",
      `Hub: ${escapeHtml(supportUrl)}`,
      `Updates: ${escapeHtml(updatesUrl)}`,
      twitterUrl ? `Twitter: ${escapeHtml(twitterUrl)}` : "",
      "",
      "Support will never ask for a seed, key, or login code.",
    ]
      .filter(Boolean)
      .join("\n"),
    inlineKeyboard([navRow()]),
    { messageId },
  );
}

async function openAbout(chatId, messageId) {
  clearUiPrompt(chatId);
  await showScreen(
    chatId,
    [
      "<b>About BLARC</b>",
      "Telegram command center for discovery, monitoring, and guarded trading.",
      "",
      "Non-custodial: Connect saves a public address only. You sign swaps.",
      "Create can show a new seed once after you confirm. It is not stored.",
      "A swap includes a 1% fee inside the transaction you sign. Otherwise nothing is sent. Trades do not repeat this.",
      "Copy watches a public wallet. Auto still asks you to sign.",
      "",
      "Ask /fee for the public fee wallet.",
    ].join("\n"),
    inlineKeyboard([navRow()]),
    { messageId },
  );
}

async function openScan(chatId, messageId) {
  clearUiPrompt(chatId);
  setPrompt(chatId, "scan_token", {});
  await showScreen(
    chatId,
    "<b>Token scan</b>\nSend a contract address to check.",
    inlineKeyboard([navRow()]),
    { messageId },
  );
}

async function openPrice(chatId, messageId) {
  clearUiPrompt(chatId);
  setPrompt(chatId, "price_lookup", {});
  await showScreen(
    chatId,
    "<b>Price</b>\nSend a token symbol or contract address.",
    inlineKeyboard([navRow()]),
    { messageId },
  );
}

async function openSettings(chatId, messageId) {
  clearUiPrompt(chatId);
  const state = await readState();
  const chat = state.chats?.[String(chatId)];
  const alertsOn = chat ? chat.alerts !== false : true;
  await showScreen(
    chatId,
    [
      "<b>Settings</b>",
      `Alerts: <b>${alertsOn ? "ON" : "OFF"}</b>`,
      `Price watches: <b>${chat?.priceWatches?.length || 0}</b>`,
      `Copy watches: <b>${chat?.copyWatches?.length || 0}</b>`,
      formatCopyStatus(chat),
    ].join("\n"),
    inlineKeyboard([
      [btn("🔔 Alerts", "ui:alerts"), btn("⚙️ Auto", "ui:auto")],
      [btn("🎯 Goal", "ui:goal"), btn("⚖️ Risk", "ui:risk")],
      navRow(),
    ]),
    { messageId },
  );
}

export async function handleUiText(message) {
  const chatId = message.chat.id;
  const prompt = peekPrompt(chatId);
  if (!prompt) {
    return false;
  }

  const text = String(message.text || "").trim();
  if (!text || text.startsWith("/")) {
    return false;
  }
  if (looksLikeSecretMaterial(text)) {
    clearUiPrompt(chatId);
    await sendMessage(chatId, "That looks like a seed phrase or private key. BLARC does not accept it. Nothing was saved.");
    await showHome(chatId, { name: message.from?.first_name });
    return true;
  }

  if (prompt.kind === "swap_sell") {
    takePrompt(chatId);
    await showBuyStep(chatId, { sell: text }, screenMessageIds.get(String(chatId)));
    return true;
  }
  if (prompt.kind === "swap_buy") {
    const draft = { ...(prompt.draft || {}), buy: text };
    takePrompt(chatId);
    await showAmountStep(chatId, draft, screenMessageIds.get(String(chatId)));
    return true;
  }
  if (prompt.kind === "swap_amount") {
    if (!/^\d+(\.\d+)?$/.test(text.replaceAll(",", "").replace(/^\$/, ""))) {
      await sendMessage(chatId, "Send a positive number, like <code>25</code>.");
      return true;
    }
    const amount = text.replaceAll(",", "").replace(/^\$/, "");
    const draft = { ...(prompt.draft || {}), amount };
    takePrompt(chatId);
    await showConfirmStep(chatId, draft, screenMessageIds.get(String(chatId)));
    return true;
  }
  if (prompt.kind === "copy_wallet") {
    takePrompt(chatId);
    await handleCopy(message, [text]);
    await showScreen(
      chatId,
      "Done. Tap below for more.",
      inlineKeyboard([[btn("📋 Copy trade", "ui:copy")], navRow()]),
    );
    return true;
  }
  if (prompt.kind === "watch_token") {
    takePrompt(chatId);
    setPrompt(chatId, "watch_draft", { token: text });
    await showScreen(
      chatId,
      `<b>New alert</b>\nToken: <b>${escapeHtml(text)}</b>\n\nAlert when price goes:`,
      inlineKeyboard([
        [btn("Above ⬆️", "ui:al:dir:above"), btn("Below ⬇️", "ui:al:dir:below")],
        navRow(),
      ]),
    );
    return true;
  }
  if (prompt.kind === "watch_price") {
    const draft = prompt.draft || {};
    takePrompt(chatId);
    if (!draft.token || !draft.dir) {
      await openAlerts(chatId);
      return true;
    }
    await handleWatch(message, [draft.token, draft.dir, text]);
    await showScreen(
      chatId,
      "Alert saved. Tap below for more.",
      inlineKeyboard([[btn("👀 Watchlist", "ui:watchlist"), btn("🔔 Alerts", "ui:alerts")], navRow()]),
    );
    return true;
  }
  if (prompt.kind === "goal_custom") {
    takePrompt(chatId);
    await handleGoal(message, [text]);
    await openGoal(chatId);
    return true;
  }
  if (prompt.kind === "scan_token") {
    takePrompt(chatId);
    const mod = await import("./commands.js");
    if (typeof mod.handleScan === "function") {
      await mod.handleScan(message, [text]);
    }
    await showScreen(chatId, "Tap Home when you are done.", inlineKeyboard([navRow()]));
    return true;
  }
  if (prompt.kind === "price_lookup") {
    takePrompt(chatId);
    const mod = await import("./commands.js");
    if (typeof mod.handlePrice === "function") {
      await mod.handlePrice(message, text.split(/\s+/));
    }
    await showScreen(chatId, "Tap Home when you are done.", inlineKeyboard([navRow()]));
    return true;
  }

  return false;
}

export async function openFeatureFromCommand(name, message, args) {
  const chatId = message.chat.id;
  switch (name) {
    case "start":
      await upsertStart(message);
      await sendGuide(chatId, "welcome.jpg", "Welcome. Tap a button below.");
      await showHome(chatId, { name: message.from?.first_name, edit: false });
      return true;
    case "help":
      await openGuide(chatId);
      return true;
    case "swap":
      if (args?.length) {
        return false;
      }
      await sendGuide(chatId, "trade.jpg", "You sign every swap. Quick swap.");
      await openSwap(chatId);
      return true;
    case "copy":
      if (args?.length) {
        return false;
      }
      await sendGuide(chatId, "copy.jpg", "Paste a public wallet. Tap Copy or Skip.");
      await openCopy(chatId);
      return true;
    case "copies":
      await openCopy(chatId);
      return true;
    case "watch":
      if (args?.length) {
        return false;
      }
      await openAlerts(chatId);
      return true;
    case "watchlist":
      await openWatchlist(chatId);
      return true;
    case "alerts":
      if (args?.length) {
        return false;
      }
      await openAlerts(chatId);
      return true;
    case "goal":
      if (args?.length) {
        return false;
      }
      await openGoal(chatId);
      return true;
    case "risk":
      if (args?.length) {
        return false;
      }
      await openRisk(chatId);
      return true;
    case "auto":
      if (args?.length) {
        return false;
      }
      await openAuto(chatId);
      return true;
    case "settings":
      await openSettings(chatId);
      return true;
    case "support":
      await openSupport(chatId);
      return true;
    case "about":
      await openAbout(chatId);
      return true;
    case "wallets":
      await openWallets(chatId);
      return true;
    case "scan":
      if (args?.length) {
        return false;
      }
      await openScan(chatId);
      return true;
    case "price":
      if (args?.length) {
        return false;
      }
      await openPrice(chatId);
      return true;
    default:
      return false;
  }
}

async function upsertStart(message) {
  const { upsertChat } = await import("./state.js");
  await upsertChat(message.chat.id, { alerts: true });
}
