import { supportUrl, twitterUrl, updatesUrl } from "./config.js";
import { formatCopyStatus, handleAuto, handleCopy, handleGoal, handleRisk, handleUncopy } from "./copy.js";
import { handleCreate } from "./createCommand.js";
import { handleAlerts, handleUnwatch, handleWatch } from "./alerts.js";
import { readState } from "./state.js";
import { executeSwap, knownTokenSymbols } from "./swap.js";
import { bridgeChain, bridgeDestinations, bridgeSources, quoteBridge, runBridge } from "./arcKit.js";
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
  ARC_CHAIN_ID,
  SOLANA_SENTINEL_CHAIN_ID,
  chainIdNumber,
  hasWalletSession,
  isEvmAddress,
  walletSessionInfo,
  looksLikeSecretMaterial,
  sanitizeWallet,
} from "./wallet.js";

const AMOUNT_PRESETS = ["10", "50", "100", "250"];
const BRIDGE_PRESETS = ["10", "50", "100", "250"];
const ARC_TOKENS = ["USDC", "EURC", "cirBTC"];
const ARC_BTC_PRESETS = ["0.0005", "0.001", "0.005", "0.01"];
const SOON = {
  onramp: "Buy USDC with card is coming soon.",
  earn: "Earn on USDC and EURC is coming soon.",
  borrow: "Borrow USDC against cirBTC is coming soon.",
  ub: "One USDC balance across chains is coming soon.",
};
/** @type {Set<string>} */
const bridgesInFlight = new Set();
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
    [btn("🌉 Bridge USDC", "ui:bridge"), btn("🟣 Arc", "ui:arc")],
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
    case "bridge":
      await answerCallbackQuery(ctx.callbackId);
      await openBridge(chatId, ctx.messageId, {});
      return;
    case "bg":
      await handleBridgeAction(chatId, args, ctx);
      return;
    case "arc":
      await answerCallbackQuery(ctx.callbackId);
      await openArc(chatId, ctx.messageId);
      return;
    case "as":
      await handleArcSwapAction(chatId, args, ctx);
      return;
    case "soon":
      await answerCallbackQuery(ctx.callbackId, SOON[args[0]] || "Coming soon.");
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

// ---------- Bridge USDC (Circle Bridge Kit) ----------

function bridgeBack() {
  return [btn("⬅️ Back", "ui:bridge"), btn("🏠 Home", "ui:home")];
}

function chainButtons(chains, prefix, star = ARC_CHAIN_ID) {
  const rows = [];
  for (let i = 0; i < chains.length; i += 2) {
    rows.push(chains.slice(i, i + 2).map((c) => btn(c.id === star ? `⭐ ${c.label}` : c.label, `${prefix}${c.id}`)));
  }
  return rows;
}

async function bridgeWalletGate(chatId, messageId, title) {
  const wallet = await connectedWallet(chatId);
  if (!wallet || !isEvmAddress(wallet.address)) {
    await showScreen(
      chatId,
      `<b>${title}</b>\nConnect an EVM wallet first. You sign every step in your own wallet.`,
      inlineKeyboard([[btn("🔗 Connect wallet", "ui:connect")], navRow()]),
      { messageId },
    );
    return null;
  }
  if (!hasWalletSession(chatId)) {
    await showScreen(
      chatId,
      `<b>${title}</b>\nYour wallet link has expired. Tap Connect wallet to pair again.`,
      inlineKeyboard([[btn("🔗 Connect wallet", "ui:connect")], navRow()]),
      { messageId },
    );
    return null;
  }
  return wallet;
}

async function openBridge(chatId, messageId, draft = {}) {
  clearUiPrompt(chatId);
  const wallet = await bridgeWalletGate(chatId, messageId, "Bridge USDC");
  if (!wallet) {
    return;
  }
  const { info, chains } = await bridgeSources(chatId);
  if (!info || chains.length === 0) {
    await showScreen(
      chatId,
      [
        "<b>Bridge USDC</b>",
        "Your wallet did not share a chain BLARC can bridge from.",
        "Supported: Arc, Base, Ethereum, Arbitrum, Optimism, Polygon.",
        "Add one in your wallet, then connect again.",
      ].join("\n"),
      inlineKeyboard([[btn("🔗 Connect wallet", "ui:connect")], navRow()]),
      { messageId },
    );
    return;
  }
  setPrompt(chatId, "bridge_draft", { ...draft, address: info.address });
  await showScreen(
    chatId,
    [
      "<b>Bridge USDC</b>",
      `Wallet: <code>${escapeHtml(info.address)}</code>`,
      draft.dst ? `To: <b>${escapeHtml(bridgeChain(draft.dst)?.label || "")}</b>` : "",
      "",
      "Move USDC between chains with Circle. Fast, and it lands in your own wallet.",
      "",
      "<b>From which chain?</b>",
    ].filter((line, i) => line !== "" || i > 2).join("\n"),
    inlineKeyboard([...chainButtons(chains, "ui:bg:src:"), navRow()]),
    { messageId },
  );
}

function bridgeDraft(chatId) {
  const prompt = peekPrompt(chatId);
  return prompt && (prompt.kind === "bridge_draft" || prompt.kind === "bridge_amount") ? { ...(prompt.draft || {}) } : null;
}

async function showBridgeDestinations(chatId, draft, messageId) {
  setPrompt(chatId, "bridge_draft", draft);
  const source = bridgeChain(draft.src);
  const destinations = bridgeDestinations(draft.src);
  await showScreen(
    chatId,
    [
      "<b>Bridge USDC</b>",
      `From: <b>${escapeHtml(source?.label || "")}</b>`,
      "",
      "<b>To which chain?</b>",
    ].join("\n"),
    inlineKeyboard([...chainButtons(destinations, "ui:bg:dst:"), bridgeBack()]),
    { messageId },
  );
}

async function showBridgeAmounts(chatId, draft, messageId) {
  setPrompt(chatId, "bridge_draft", draft);
  await showScreen(
    chatId,
    [
      "<b>Bridge USDC</b>",
      `From: <b>${escapeHtml(bridgeChain(draft.src)?.label || "")}</b> → To: <b>${escapeHtml(bridgeChain(draft.dst)?.label || "")}</b>`,
      "",
      "<b>How much USDC?</b>",
    ].join("\n"),
    inlineKeyboard([
      BRIDGE_PRESETS.slice(0, 2).map((a) => btn(`${a} USDC`, `ui:bg:amt:${a}`)),
      BRIDGE_PRESETS.slice(2).map((a) => btn(`${a} USDC`, `ui:bg:amt:${a}`)),
      [btn("✏️ Custom amount", "ui:bg:amt:custom")],
      bridgeBack(),
    ]),
    { messageId },
  );
}

async function showBridgeConfirm(chatId, draft, messageId) {
  setPrompt(chatId, "bridge_draft", draft);
  const source = bridgeChain(draft.src);
  const destination = bridgeChain(draft.dst);
  await showScreen(
    chatId,
    `<b>Bridge USDC</b>\nGetting a quote for ${escapeHtml(draft.amount)} USDC…`,
    inlineKeyboard([bridgeBack()]),
    { messageId },
  );
  const quote = await quoteBridge({
    chatId,
    address: draft.address,
    sourceId: draft.src,
    destinationId: draft.dst,
    amount: draft.amount,
  });
  if (quote.error) {
    await showScreen(
      chatId,
      `<b>Bridge USDC</b>\n${escapeHtml(quote.error)} Nothing was signed.`,
      inlineKeyboard([[btn("🔁 Try again", "ui:bridge")], navRow()]),
      { messageId },
    );
    return;
  }
  await showScreen(
    chatId,
    [
      "<b>Confirm bridge</b>",
      `Wallet: <code>${escapeHtml(draft.address)}</code>`,
      `From: <b>${escapeHtml(source.label)}</b>`,
      `To: <b>${escapeHtml(destination.label)}</b> (same wallet)`,
      `Send: <b>${escapeHtml(quote.amount)} USDC</b>`,
      `Arrives: <b>~${escapeHtml(quote.arrive)} USDC</b>`,
      "",
      `Your wallet asks twice on ${escapeHtml(source.label)}: approve, then bridge. Circle delivers on ${escapeHtml(destination.label)} for you.`,
      source.id === ARC_CHAIN_ID ? "Gas on Arc is paid in USDC." : "",
    ].filter(Boolean).join("\n"),
    inlineKeyboard([
      [btn("✅ Confirm", "ui:bg:go"), btn("❌ Cancel", "ui:bg:cancel")],
      bridgeBack(),
    ]),
    { messageId },
  );
}

async function handleBridgeAction(chatId, args, ctx) {
  const step = args[0] || "";
  const value = args.slice(1).join(":");
  if (step === "toarc") {
    await answerCallbackQuery(ctx.callbackId);
    await openBridge(chatId, ctx.messageId, { dst: ARC_CHAIN_ID });
    return;
  }
  if (step === "cancel") {
    await answerCallbackQuery(ctx.callbackId, "Cancelled");
    clearUiPrompt(chatId);
    await showHome(chatId, { messageId: ctx.messageId, name: ctx.from?.first_name });
    return;
  }
  const draft = bridgeDraft(chatId);
  if (!draft?.address) {
    await answerCallbackQuery(ctx.callbackId, "Start the bridge again");
    await openBridge(chatId, ctx.messageId, {});
    return;
  }
  if (step === "src" && bridgeChain(value)) {
    await answerCallbackQuery(ctx.callbackId);
    const next = { ...draft, src: Number(value) };
    if (next.dst && next.dst !== next.src && bridgeDestinations(next.src).some((c) => c.id === next.dst)) {
      await showBridgeAmounts(chatId, next, ctx.messageId);
    } else {
      delete next.dst;
      await showBridgeDestinations(chatId, next, ctx.messageId);
    }
    return;
  }
  if (step === "dst" && bridgeChain(value) && draft.src) {
    await answerCallbackQuery(ctx.callbackId);
    await showBridgeAmounts(chatId, { ...draft, dst: Number(value) }, ctx.messageId);
    return;
  }
  if (step === "amt" && value === "custom" && draft.src && draft.dst) {
    await answerCallbackQuery(ctx.callbackId);
    setPrompt(chatId, "bridge_amount", draft);
    await showScreen(
      chatId,
      "<b>Bridge USDC</b>\nSend the USDC amount as a number, like <code>25</code>.",
      inlineKeyboard([bridgeBack()]),
      { messageId: ctx.messageId },
    );
    return;
  }
  if (step === "amt" && value && draft.src && draft.dst) {
    await answerCallbackQuery(ctx.callbackId, "Getting a quote…");
    await showBridgeConfirm(chatId, { ...draft, amount: value }, ctx.messageId);
    return;
  }
  if (step === "go" && draft.src && draft.dst && draft.amount) {
    const key = String(chatId);
    if (bridgesInFlight.has(key)) {
      await answerCallbackQuery(ctx.callbackId, "A bridge is already running");
      return;
    }
    await answerCallbackQuery(ctx.callbackId, "Check your wallet…");
    clearUiPrompt(chatId);
    const source = bridgeChain(draft.src);
    const destination = bridgeChain(draft.dst);
    await showScreen(
      chatId,
      [
        "<b>Bridge USDC</b>",
        `Open your wallet and approve on ${escapeHtml(source.label)}.`,
        `${escapeHtml(draft.amount)} USDC → ${escapeHtml(destination.label)}`,
        "Your wallet will ask twice: approve, then bridge.",
      ].join("\n"),
      inlineKeyboard([navRow()]),
      { messageId: ctx.messageId },
    );
    bridgesInFlight.add(key);
    // The bridge waits on Circle's attestation and forwarder, so it runs off the update loop.
    runBridgeInBackground(chatId, draft).finally(() => bridgesInFlight.delete(key));
    return;
  }
  await answerCallbackQuery(ctx.callbackId);
  await openBridge(chatId, ctx.messageId, {});
}

async function runBridgeInBackground(chatId, draft) {
  let announcedBurn = false;
  try {
    const result = await runBridge({
      chatId,
      address: draft.address,
      sourceId: draft.src,
      destinationId: draft.dst,
      amount: draft.amount,
      onProgress: async ({ name, hash, source, destination }) => {
        if (!announcedBurn && /burn/i.test(name) && hash) {
          announcedBurn = true;
          await sendMessage(
            chatId,
            [
              `🌉 <b>Bridge sent from ${escapeHtml(source.label)}</b>`,
              `Tx: <code>${escapeHtml(hash)}</code>`,
              `Circle is delivering your USDC on ${escapeHtml(destination.label)}. This usually takes under a few minutes.`,
            ].join("\n"),
          );
        }
      },
    });
    await sendMessage(chatId, bridgeResultText(result), { reply_markup: homeKeyboard() });
  } catch (error) {
    console.error("bridge run failed:", String(error?.message || "error").slice(0, 120));
    await sendMessage(chatId, "Bridge stopped. Nothing further was sent. Tap Home to try again.", {
      reply_markup: homeKeyboard(),
    }).catch(() => {});
  }
}

function bridgeResultText(result) {
  if (result.text) {
    return escapeHtml(result.text);
  }
  const route = `${escapeHtml(result.source.label)} → ${escapeHtml(result.destination.label)}`;
  if (result.ok) {
    return [
      "✅ <b>Bridge complete</b>",
      `${escapeHtml(result.amount)} USDC · ${route}`,
      result.burnUrl ? `<a href="${escapeHtml(result.burnUrl)}">Source tx</a>` : "",
      result.mintUrl ? `<a href="${escapeHtml(result.mintUrl)}">Delivery tx</a>` : "",
      "Funds are in your own wallet.",
    ].filter(Boolean).join("\n");
  }
  if (result.burnHash) {
    return [
      "⏳ <b>Bridge sent, delivery still pending</b>",
      `${escapeHtml(result.amount)} USDC · ${route}`,
      `Source tx: <code>${escapeHtml(result.burnHash)}</code>`,
      "Your USDC is safe in Circle's transfer. It is delivered to your wallet once Circle finishes. If it has not arrived in 30 minutes, share the source tx with support.",
    ].join("\n");
  }
  return [
    "Bridge not completed.",
    result.failedReason ? escapeHtml(result.failedReason) : "",
    "Nothing was bridged. If you approved first, that approval only covers this amount.",
  ].filter(Boolean).join("\n");
}

// ---------- Arc hub + Arc swap (Circle Swap Kit) ----------

async function openArc(chatId, messageId) {
  clearUiPrompt(chatId);
  await showScreen(
    chatId,
    [
      "<b>🟣 Arc</b>",
      "Circle's stablecoin chain. USDC pays the gas, and trades settle in under a second.",
      "",
      "• Swap USDC, EURC and cirBTC",
      "• Bridge USDC in from Base, Ethereum, Arbitrum and more",
      "",
      "Powered by Circle App Kits. You sign every step.",
    ].join("\n"),
    inlineKeyboard([
      [btn("💱 Swap on Arc", "ui:as:open"), btn("🌉 Bridge to Arc", "ui:bg:toarc")],
      [btn("💳 Buy USDC · soon", "ui:soon:onramp"), btn("📈 Earn · soon", "ui:soon:earn")],
      [btn("🏦 Borrow · soon", "ui:soon:borrow"), btn("🧮 One balance · soon", "ui:soon:ub")],
      navRow(),
    ]),
    { messageId },
  );
}

function arcBack() {
  return [btn("⬅️ Back", "ui:arc"), btn("🏠 Home", "ui:home")];
}

function arcSwapDraft(chatId) {
  const prompt = peekPrompt(chatId);
  return prompt && (prompt.kind === "arcswap_draft" || prompt.kind === "arcswap_amount") ? { ...(prompt.draft || {}) } : {};
}

async function openArcSwap(chatId, messageId) {
  clearUiPrompt(chatId);
  const wallet = await bridgeWalletGate(chatId, messageId, "Swap on Arc");
  if (!wallet) {
    return;
  }
  const info = await walletSessionInfo(chatId);
  if (!info?.chainIds?.has(ARC_CHAIN_ID)) {
    await showScreen(
      chatId,
      [
        "<b>Swap on Arc</b>",
        "Your wallet did not share Arc yet.",
        "Add Arc in your wallet: chain id <code>5042</code>, RPC <code>https://rpc.mainnet.arc.io</code>, gas coin USDC. Then connect again.",
        "",
        "No USDC on Arc yet? Bridge some in first.",
      ].join("\n"),
      inlineKeyboard([[btn("🌉 Bridge to Arc", "ui:bg:toarc"), btn("🔗 Connect wallet", "ui:connect")], arcBack()]),
      { messageId },
    );
    return;
  }
  setPrompt(chatId, "arcswap_draft", { address: info.address });
  await showScreen(
    chatId,
    [
      "<b>Swap on Arc</b>",
      `Wallet: <code>${escapeHtml(info.address)}</code>`,
      "",
      "What are you selling?",
    ].join("\n"),
    inlineKeyboard([ARC_TOKENS.map((t) => btn(t, `ui:as:sell:${t}`)), arcBack()]),
    { messageId },
  );
}

async function showArcSwapConfirm(chatId, draft, messageId) {
  setPrompt(chatId, "arcswap_draft", draft);
  await showScreen(
    chatId,
    [
      "<b>Confirm swap · Arc</b>",
      `Wallet: <code>${escapeHtml(draft.address)}</code>`,
      `Sell: <b>${escapeHtml(draft.amount)} ${escapeHtml(draft.sell)}</b>`,
      `Buy: <b>${escapeHtml(draft.buy)}</b>`,
      "",
      "Your wallet asks to sign a permit, then the swap. Tap Confirm to continue.",
    ].join("\n"),
    inlineKeyboard([[btn("✅ Confirm", "ui:as:go"), btn("❌ Cancel", "ui:as:cancel")], arcBack()]),
    { messageId },
  );
}

async function handleArcSwapAction(chatId, args, ctx) {
  const step = args[0] || "";
  const value = args.slice(1).join(":");
  if (step === "open") {
    await answerCallbackQuery(ctx.callbackId);
    await openArcSwap(chatId, ctx.messageId);
    return;
  }
  if (step === "cancel") {
    await answerCallbackQuery(ctx.callbackId, "Cancelled");
    clearUiPrompt(chatId);
    await openArc(chatId, ctx.messageId);
    return;
  }
  const draft = arcSwapDraft(chatId);
  if (!draft.address) {
    await answerCallbackQuery(ctx.callbackId, "Start the swap again");
    await openArcSwap(chatId, ctx.messageId);
    return;
  }
  if (step === "sell" && ARC_TOKENS.includes(value)) {
    await answerCallbackQuery(ctx.callbackId);
    const next = { address: draft.address, sell: value };
    setPrompt(chatId, "arcswap_draft", next);
    await showScreen(
      chatId,
      ["<b>Swap on Arc</b>", `Selling: <b>${escapeHtml(value)}</b>`, "", "What do you want to buy?"].join("\n"),
      inlineKeyboard([ARC_TOKENS.filter((t) => t !== value).map((t) => btn(t, `ui:as:buy:${t}`)), [btn("⬅️ Back", "ui:as:open"), btn("🏠 Home", "ui:home")]]),
      { messageId: ctx.messageId },
    );
    return;
  }
  if (step === "buy" && ARC_TOKENS.includes(value) && draft.sell && value !== draft.sell) {
    await answerCallbackQuery(ctx.callbackId);
    const next = { ...draft, buy: value };
    setPrompt(chatId, "arcswap_draft", next);
    const presets = draft.sell === "cirBTC" ? ARC_BTC_PRESETS : AMOUNT_PRESETS;
    await showScreen(
      chatId,
      ["<b>Swap on Arc</b>", `Sell: <b>${escapeHtml(draft.sell)}</b>`, `Buy: <b>${escapeHtml(value)}</b>`, "", `How much ${escapeHtml(draft.sell)}?`].join("\n"),
      inlineKeyboard([
        presets.slice(0, 2).map((a) => btn(a, `ui:as:amt:${a}`)),
        presets.slice(2).map((a) => btn(a, `ui:as:amt:${a}`)),
        [btn("✏️ Custom amount", "ui:as:amt:custom")],
        [btn("⬅️ Back", "ui:as:open"), btn("🏠 Home", "ui:home")],
      ]),
      { messageId: ctx.messageId },
    );
    return;
  }
  if (step === "amt" && value === "custom" && draft.sell && draft.buy) {
    await answerCallbackQuery(ctx.callbackId);
    setPrompt(chatId, "arcswap_amount", draft);
    await showScreen(
      chatId,
      `<b>Swap on Arc</b>\nSend the ${escapeHtml(draft.sell)} amount as a number.`,
      inlineKeyboard([arcBack()]),
      { messageId: ctx.messageId },
    );
    return;
  }
  if (step === "amt" && value && draft.sell && draft.buy) {
    await answerCallbackQuery(ctx.callbackId);
    await showArcSwapConfirm(chatId, { ...draft, amount: value }, ctx.messageId);
    return;
  }
  if (step === "go" && draft.sell && draft.buy && draft.amount) {
    await answerCallbackQuery(ctx.callbackId, "Check your wallet…");
    clearUiPrompt(chatId);
    const wallet = await connectedWallet(chatId);
    if (!wallet) {
      await openArcSwap(chatId, ctx.messageId);
      return;
    }
    await showScreen(
      chatId,
      [
        "<b>Swap on Arc</b>",
        "Asking your wallet to sign…",
        `Sell: <b>${escapeHtml(draft.amount)} ${escapeHtml(draft.sell)}</b>`,
        `Buy: <b>${escapeHtml(draft.buy)}</b>`,
      ].join("\n"),
      inlineKeyboard([navRow()]),
      { messageId: ctx.messageId },
    );
    const reply = await executeSwap({
      chatId,
      wallet: { ...wallet, address: draft.address, chainId: `eip155:${ARC_CHAIN_ID}` },
      amount: draft.amount,
      tokenIn: draft.sell,
      tokenOut: draft.buy,
    });
    await sendMessage(chatId, reply, { reply_markup: homeKeyboard() });
    return;
  }
  await answerCallbackQuery(ctx.callbackId);
  await openArcSwap(chatId, ctx.messageId);
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
      "• Bridge USDC — move USDC between chains with Circle",
      "• Arc — swap USDC, EURC and cirBTC on Arc",
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
      "Bridge USDC and Arc swaps run on Circle App Kits. The same 1% is included inside the bridge or swap you sign.",
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
  if (prompt.kind === "bridge_amount" || prompt.kind === "arcswap_amount") {
    const amount = text.replaceAll(",", "").replace(/^\$/, "");
    if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) {
      await sendMessage(chatId, "Send a positive number, like <code>25</code>.");
      return true;
    }
    const draft = { ...(prompt.draft || {}), amount };
    takePrompt(chatId);
    if (prompt.kind === "bridge_amount") {
      await showBridgeConfirm(chatId, draft, screenMessageIds.get(String(chatId)));
    } else {
      await showArcSwapConfirm(chatId, draft, screenMessageIds.get(String(chatId)));
    }
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
    case "bridge":
      await openBridge(chatId, undefined, {});
      return true;
    case "arc":
      await openArc(chatId);
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
