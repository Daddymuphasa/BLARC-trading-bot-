import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { buildMarketRiskLines, classifyAddress, findBestPair, findTrackedPair, formatPairSummary, formatUsd } from "./dexscreener.js";
import { loadEnvFile } from "./env.js";
import {
  adoptSession,
  beginPairing,
  buildSwapPreview,
  disconnectTopic,
  dropChatSession,
  feeWalletStatus,
  looksLikeSecretMaterial,
  pairingQrPng,
  parseSwapCommand,
  publicWalletError,
  publicWalletFromSession,
  sanitizeWallet,
} from "./wallet.js";

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
const priceCheckIntervalMs = 60_000;
const priceCheckGapMs = 400;
const maxPriceWatches = 20;
let offset = 0;
let stateLock = Promise.resolve();
const pairingGeneration = new Map();

if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN. Copy .env.example, set your BotFather token, then run `npm start`.");
  process.exit(1);
}

const commands = {
  start: handleStart,
  help: handleHelp,
  connect: handleConnect,
  disconnect: handleDisconnect,
  fee: handleFee,
  swap: handleSwap,
  wallet: handleWallet,
  wallets: handleWallets,
  remove_wallet: handleRemoveWallet,
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
      "This MVP is live in safe mode: token scans, read-only wallets, DexScreener price alerts, support links, and product onboarding.",
      "",
      "<b>Quick commands</b>",
      "/connect - pair a wallet you control (WalletConnect)",
      "/disconnect - forget the connected public address",
      "/fee - show the 1% in-swap fee wallet",
      "/swap &lt;amount&gt; &lt;from&gt; &lt;to&gt; - preview a swap, nothing is broadcast",
      "/wallet &lt;address&gt; - add a read-only wallet",
      "/wallets - view saved wallets",
      "/scan &lt;contract&gt; - run token and market risk checks",
      "/watch &lt;token&gt; above &lt;usd&gt; - alert when price crosses a target",
      "/watchlist - token watches, last price, and targets",
      "/price &lt;token&gt; - lookup live DEX price",
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
      "/connect - pair your own wallet with WalletConnect",
      "/disconnect - forget the connected public address",
      "/fee - show the public 1% fee wallet",
      "/swap &lt;amount&gt; &lt;from&gt; &lt;to&gt; - preview a swap (no broadcast)",
      "/wallet &lt;address&gt; - add a read-only wallet",
      "/wallets - list saved wallets",
      "/remove_wallet &lt;address&gt; - remove a saved wallet",
      "/scan &lt;contract&gt; - token and market risk checks",
      "/watch &lt;token&gt; [above &lt;usd&gt;] [below &lt;usd&gt;] - watch a token price",
      "/watch &lt;token&gt; rearm - arm fired targets again",
      "/unwatch &lt;token&gt; - remove a token price watch",
      "/watchlist - token, last price, and above/below targets",
      "/price &lt;token&gt; - live DEX price lookup",
      "/alerts on|off - turn price alert delivery on or off",
      "/settings - current preferences",
      "/support - official support links",
      "/about - BLARC product status",
    ].join("\n"),
  );
}

async function handleConnect(message, args) {
  if (looksLikeSecretMaterial(args.join(" "))) {
    await sendMessage(
      message.chat.id,
      "BLARC does not accept seed phrases or private keys. Create a wallet in your own wallet app, then run /connect and approve the pairing there.",
    );
    return;
  }

  if (!String(process.env.WALLETCONNECT_PROJECT_ID || "").trim()) {
    await sendMessage(
      message.chat.id,
      "WALLETCONNECT_PROJECT_ID is not set, so WalletConnect pairing cannot start.",
    );
    return;
  }

  const chatId = message.chat.id;
  const generation = nextPairingGeneration(chatId);
  let pairing;
  try {
    pairing = await beginPairing();
  } catch (error) {
    console.error("WalletConnect pairing failed to start:", publicWalletError(error));
    if (currentPairingGeneration(chatId) !== generation) {
      return;
    }
    await sendMessage(
      chatId,
      `WalletConnect pairing could not start (${escapeHtml(publicWalletError(error))}). No wallet session was saved.`,
    );
    return;
  }

  watchPairingApproval(chatId, generation, pairing.approval);
  if (currentPairingGeneration(chatId) !== generation) {
    return;
  }

  await sendMessage(
    chatId,
    [
      "<b>Connect your wallet</b>",
      "Scan the QR in your own wallet app, or paste the pairing URI that follows into that app.",
      "",
      "No wallet yet? Create one in MetaMask, Rainbow, Trust Wallet, or another wallet you control, then approve this pairing. BLARC does not generate a wallet and will never show a seed phrase.",
      "",
      "Approving shares a public address only. This step does not send a transaction.",
    ].join("\n"),
  );

  try {
    const png = await pairingQrPng(pairing.uri);
    await sendPhoto(chatId, png, "BLARC WalletConnect pairing QR. Your keys stay in your wallet app.");
  } catch (error) {
    console.error("WalletConnect QR failed:", publicWalletError(error));
    await sendMessage(chatId, "The QR image could not be sent. Use the pairing URI below in your wallet app.");
  }

  if (currentPairingGeneration(chatId) !== generation) {
    return;
  }

  await sendPlain(chatId, pairing.uri);
}

function nextPairingGeneration(chatId) {
  const next = currentPairingGeneration(chatId) + 1;
  pairingGeneration.set(String(chatId), next);
  return next;
}

function currentPairingGeneration(chatId) {
  return pairingGeneration.get(String(chatId)) || 0;
}

function watchPairingApproval(chatId, generation, approval) {
  approval()
    .then((session) => finishPairing(chatId, generation, session))
    .catch((error) => failPairing(chatId, generation, error));
}

async function finishPairing(chatId, generation, session) {
  if (currentPairingGeneration(chatId) !== generation) {
    await disconnectTopic(session?.topic);
    return;
  }

  const account = publicWalletFromSession(session);
  if (!account) {
    await disconnectTopic(session?.topic);
    await sendMessage(
      chatId,
      "The wallet did not share an EVM public address, so nothing was saved. Pair again from a wallet that can share an Ethereum account. Do not paste a seed phrase or private key.",
    );
    return;
  }

  try {
    await mutateState((state) => {
      const chat = ensureChatState(state, chatId);
      chat.wallet = { address: account.address, chainId: account.chainId };
    });
    await adoptSession(chatId, session.topic);
  } catch (error) {
    await disconnectTopic(session?.topic);
    console.error("WalletConnect address save failed:", publicWalletError(error));
    await sendMessage(
      chatId,
      "The wallet approved, but the public address could not be saved. Nothing secret was stored. Run /connect again.",
    );
    return;
  }

  await sendMessage(
    chatId,
    [
      "<b>Wallet connected</b>",
      `Address: <code>${escapeHtml(account.address)}</code>`,
      `Chain: <code>${escapeHtml(account.chainId)}</code>`,
      "",
      "Saved the public address and chain id only. Your keys stay in your wallet app.",
      "Use /swap to preview a trade. BLARC does not broadcast a transaction.",
      "/disconnect forgets this address.",
    ].join("\n"),
  );
}

async function failPairing(chatId, generation, error) {
  if (currentPairingGeneration(chatId) !== generation) {
    return;
  }
  console.error("WalletConnect approval failed:", publicWalletError(error));
  try {
    await sendMessage(
      chatId,
      `Wallet pairing was not approved, so no address was saved (${escapeHtml(publicWalletError(error))}). Run /connect to try again. BLARC will not ask for a seed phrase or private key.`,
    );
  } catch (sendError) {
    console.error("WalletConnect failure notice failed:", publicWalletError(sendError));
  }
}

async function handleDisconnect(message) {
  nextPairingGeneration(message.chat.id);
  await dropChatSession(message.chat.id);
  const outcome = await mutateState((state) => {
    const chat = ensureChatState(state, message.chat.id);
    const had = Boolean(sanitizeWallet(chat.wallet));
    chat.wallet = null;
    return { had };
  });
  await sendMessage(
    message.chat.id,
    outcome.had
      ? "Disconnected. This chat forgot the public address. Your keys were never stored here."
      : "No connected wallet was saved for this chat.",
  );
}

async function handleFee(message) {
  const status = feeWalletStatus();
  if (status.state === "missing") {
    await sendMessage(
      message.chat.id,
      "No fee wallet is set. The swap cut is 1% (100 bps), taken inside a swap only after the public BLARC_FEE_ADDRESS is configured.",
    );
    return;
  }
  if (status.state !== "ok") {
    await sendMessage(
      message.chat.id,
      "A fee wallet value is present, but it is not a valid public EVM address, so it is not used. The swap cut is 1% (100 bps).",
    );
    return;
  }
  const lines = ["<b>BLARC swap fee</b>", "Cut: <b>1%</b> (100 bps), taken inside the swap. BLARC does not take custody of funds."];
  if (status.evm) lines.push(`EVM: <code>${escapeHtml(status.evm)}</code>`);
  if (status.sol) {
    lines.push(`Solana: <code>${escapeHtml(status.sol)}</code>`);
    lines.push("Solana swaps are not live yet, so this address is saved and not used on a trade.");
  }
  if (status.robinhood) lines.push(`Robinhood: <code>${escapeHtml(status.robinhood)}</code>`);
  if (status.arc) lines.push(`Arc: <code>${escapeHtml(status.arc)}</code>`);
  if (!status.evm) lines.push("No EVM fee wallet is set, so an EVM swap preview will still refuse.");
  await sendMessage(message.chat.id, lines.join("\n"));
}

async function handleSwap(message, args) {
  if (looksLikeSecretMaterial(args.join(" "))) {
    await sendMessage(
      message.chat.id,
      "Swap refused. BLARC does not accept seed phrases or private keys. Nothing was broadcast.",
    );
    return;
  }

  const state = await readState();
  const wallet = sanitizeWallet(state.chats?.[String(message.chat.id)]?.wallet);
  if (!wallet) {
    await sendMessage(message.chat.id, "No wallet is connected for this chat. Use /connect, then approve it in your own wallet app.");
    return;
  }

  const fee = feeWalletStatus();
  if (fee.state !== "ok") {
    await sendMessage(message.chat.id, "Swap refused. The fee wallet is not set.");
    return;
  }

  const parsed = parseSwapCommand(args);
  if (parsed.error === "amount") {
    await sendMessage(message.chat.id, "That amount is not a positive number. Example: /swap 100 USDC ETH");
    return;
  }
  if (parsed.error === "token") {
    await sendMessage(
      message.chat.id,
      "Use a token symbol or a public 0x token address. Example: /swap 100 USDC ETH",
    );
    return;
  }
  if (parsed.error === "same") {
    await sendMessage(message.chat.id, "Choose two different tokens. Nothing was broadcast.");
    return;
  }
  if (parsed.error) {
    await sendMessage(
      message.chat.id,
      "Usage: /swap &lt;amount&gt; &lt;from-token&gt; &lt;to-token&gt;\nExample: /swap 100 USDC ETH\nThis is a preview only. No transaction is broadcast.",
    );
    return;
  }

  const preview = buildSwapPreview({
    amount: parsed.amount,
    tokenIn: parsed.tokenIn,
    tokenOut: parsed.tokenOut,
    wallet,
    feeAddress: fee.address,
  });
  if (!preview) {
    await sendMessage(message.chat.id, "Swap refused. The preview could not be built, and nothing was broadcast.");
    return;
  }

  await sendMessage(
    message.chat.id,
    [
      "<b>BLARC Swap Preview</b>",
      "Preview only. No transaction was broadcast.",
      "",
      `Wallet: <code>${escapeHtml(preview.address)}</code>`,
      `Chain: <code>${escapeHtml(preview.chainId)}</code>`,
      `Sell: <b>${escapeHtml(preview.amount)} ${escapeHtml(preview.tokenIn)}</b>`,
      `Buy: <b>${escapeHtml(preview.tokenOut)}</b>`,
      "Fee: <b>1%</b> (100 bps) of the sold amount",
      `Fee wallet: <code>${escapeHtml(preview.feeAddress)}</code>`,
      `Fee amount: <b>${escapeHtml(preview.fee)} ${escapeHtml(preview.tokenIn)}</b>`,
      `Amount after fee: <b>${escapeHtml(preview.net)} ${escapeHtml(preview.tokenIn)}</b>`,
      "",
      "The 1% goes to the fee wallet inside the swap, as the swap's fee recipient. BLARC does not take custody of the funds.",
      "There is no quoted output yet, because no swap was built or signed.",
      "Do not paste a seed phrase or private key.",
    ].join("\n"),
  );
}


async function handleWallet(message, args) {
  return addWallet(message, args, {
    emptyUsage: "Usage: /wallet &lt;public-wallet-address&gt;",
    savedPrefix: "Read-only wallet saved",
  });
}

async function handleWallets(message) {
  return listWallets(message);
}

async function handleRemoveWallet(message, args) {
  return removeWallet(message, args, {
    emptyUsage: "Usage: /remove_wallet &lt;public-wallet-address&gt;",
  });
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
  const parsed = parseWatchCommand(args);
  if (parsed.error === "usage") {
    await sendMessage(message.chat.id, watchUsageText());
    return;
  }
  if (parsed.error === "price") {
    await sendMessage(
      message.chat.id,
      `That ${parsed.which} target is not a USD price. Use a number like 0.25 or 0.000012.`,
    );
    return;
  }

  const snapshot = await readState();
  const existingMatches = matchingWatches(snapshot.chats?.[String(message.chat.id)]?.priceWatches || [], parsed.query);
  if (existingMatches.length > 1) {
    await sendMessage(message.chat.id, ambiguousWatchText(existingMatches));
    return;
  }

  const existing = existingMatches[0] || null;
  const setsTarget = parsed.above !== undefined || parsed.below !== undefined;
  const onlyRearmOrClear = (parsed.rearm || parsed.clearAbove || parsed.clearBelow) && !setsTarget;
  if (!existing && onlyRearmOrClear) {
    await sendMessage(
      message.chat.id,
      `You are not watching <code>${escapeHtml(parsed.query)}</code>. Add it with /watch &lt;token&gt; above &lt;usd&gt;.`,
    );
    return;
  }

  const projectedAbove = parsed.clearAbove ? null : parsed.above !== undefined ? parsed.above : (existing?.above ?? null);
  const projectedBelow = parsed.clearBelow ? null : parsed.below !== undefined ? parsed.below : (existing?.below ?? null);
  if (projectedAbove != null && projectedBelow != null && !(projectedAbove > projectedBelow)) {
    await sendMessage(message.chat.id, "The above target must be higher than the below target. Nothing was changed.");
    return;
  }

  let pair = null;
  let lookupError = null;
  const clearOnly = (parsed.clearAbove || parsed.clearBelow) && !setsTarget && !parsed.rearm;
  const arming = setsTarget || parsed.rearm;
  // Rearm used to skip the lookup and keep the old lastPriceUsd anchor.
  // Setting or re-arming needs a fresh price for this token.
  if (!existing || !clearOnly) {
    try {
      pair = await findTrackedPair(existing?.chainId && existing?.tokenAddress ? existing : { query: parsed.query });
    } catch (error) {
      lookupError = error;
    }
  }

  const freshPrice = freshTrackedPrice(existing, pair);
  if (arming && freshPrice == null) {
    await sendMessage(message.chat.id, targetNotArmedText(parsed.query, lookupError));
    return;
  }

  if (!existing && freshPrice == null) {
    if (lookupError) {
      await sendMessage(
        message.chat.id,
        [
          "<b>Price Watch Failed</b>",
          `DexScreener lookup failed for <code>${escapeHtml(parsed.query)}</code>.`,
          "",
          `Reason: ${escapeHtml(lookupError.message)}`,
          "Nothing was saved. Try again in a minute.",
        ].join("\n"),
      );
      return;
    }

    await sendMessage(
      message.chat.id,
      `No active DexScreener pair found for <code>${escapeHtml(parsed.query)}</code>. Watch a contract address or a symbol DexScreener lists.`,
    );
    return;
  }

  const outcome = await mutateState((state) => {
    const chat = ensureChatState(state, message.chat.id);
    const matches = matchingWatches(chat.priceWatches, parsed.query);
    if (matches.length > 1) {
      return { status: "ambiguous", matches, skipSave: true };
    }

    let watch = matches[0] || null;
    if (!watch && pair?.baseToken?.address) {
      const byToken = chat.priceWatches.filter((item) => sameToken(item, pair));
      if (byToken.length > 1) {
        return { status: "ambiguous", matches: byToken, skipSave: true };
      }
      watch = byToken[0] || null;
    }

    const draft = watch ? { ...watch } : blankPriceWatch(parsed.query);
    if (!draft.id) {
      draft.id = randomUUID();
    }
    if (typeof draft.revision !== "number") {
      draft.revision = 0;
    }
    if (pair && freshPrice != null) {
      applyPairSnapshot(draft, pair);
    }
    let targetsChanged = false;
    if (parsed.clearAbove) {
      draft.above = null;
      draft.aboveFired = false;
      draft.aboveSeenPrice = null;
      targetsChanged = true;
    }
    if (parsed.clearBelow) {
      draft.below = null;
      draft.belowFired = false;
      draft.belowSeenPrice = null;
      targetsChanged = true;
    }
    if (parsed.above !== undefined) {
      draft.above = parsed.above;
      draft.aboveFired = false;
      draft.aboveSeenPrice = freshPrice;
      targetsChanged = true;
    }
    if (parsed.below !== undefined) {
      draft.below = parsed.below;
      draft.belowFired = false;
      draft.belowSeenPrice = freshPrice;
      targetsChanged = true;
    }
    if (parsed.rearm) {
      rearmWatch(draft, freshPrice);
      targetsChanged = true;
    }
    if (targetsChanged) {
      bumpWatchRevision(draft);
    }
    if (draft.above != null && draft.below != null && !(draft.above > draft.below)) {
      return { status: "range", skipSave: true };
    }

    if (!watch) {
      if (chat.priceWatches.length >= maxPriceWatches) {
        return { status: "limit", skipSave: true };
      }
      chat.priceWatches.push(draft);
    } else {
      Object.assign(watch, draft);
    }

    return {
      status: watch ? "updated" : "created",
      alerts: chat.alerts !== false,
      watch: { ...draft },
    };
  });

  if (outcome.status === "ambiguous") {
    await sendMessage(message.chat.id, ambiguousWatchText(outcome.matches));
    return;
  }
  if (outcome.status === "limit") {
    await sendMessage(message.chat.id, `Price watch limit reached (${maxPriceWatches}). Remove one with /unwatch &lt;token&gt;.`);
    return;
  }
  if (outcome.status === "range") {
    await sendMessage(message.chat.id, "The above target must be higher than the below target. Nothing was changed.");
    return;
  }

  await sendMessage(message.chat.id, formatWatchConfirmation(outcome.watch, outcome.status, outcome.alerts));
}

async function handleWatchlist(message) {
  const state = await readState();
  const chat = state.chats?.[String(message.chat.id)];
  const watches = chat?.priceWatches || [];
  const alertsOn = chat ? chat.alerts !== false : true;

  if (watches.length === 0) {
    await sendMessage(
      message.chat.id,
      [
        "No token price watches yet.",
        "Add one with /watch &lt;token&gt; above &lt;usd&gt; or /watch &lt;token&gt; below &lt;usd&gt;.",
        "Wallets stay on /wallet and /wallets. Price alerts do not trade.",
      ].join("\n"),
    );
    return;
  }

  const lines = watches.map((watch, index) => {
    const label = watch.symbol || watch.query;
    const name = watch.name && watch.name !== label ? `${label} - ${watch.name}` : label;
    return [
      `${index + 1}. <b>${escapeHtml(name)}</b>${watch.chainId ? ` (${escapeHtml(watch.chainId)})` : ""}`,
      `   Token: <code>${escapeHtml(watch.tokenAddress || watch.query)}</code>`,
      `   Last: <b>${formatUsd(watch.lastPriceUsd)}</b>`,
      `   Above: <b>${formatTarget(watch.above, watch.aboveFired)}</b>`,
      `   Below: <b>${formatTarget(watch.below, watch.belowFired)}</b>`,
      `   Checked: ${escapeHtml(formatCheckedAt(watch.lastCheckedAt))}`,
    ].join("\n");
  });

  await sendMessage(
    message.chat.id,
    [
      "<b>BLARC price watches</b>",
      `Alerts: <b>${alertsOn ? "ON" : "OFF"}</b>`,
      "",
      ...lines,
      "",
      "A target fires once when price crosses it. Re-arm with /watch &lt;token&gt; rearm.",
      "Remove one with /unwatch &lt;token&gt;. This does not place a trade.",
    ].join("\n"),
  );
}

async function handleUnwatch(message, args) {
  const query = args.join(" ").trim();
  if (!query) {
    await sendMessage(message.chat.id, "Usage: /unwatch &lt;token&gt;");
    return;
  }

  const outcome = await mutateState((state) => {
    const chat = ensureChatState(state, message.chat.id);
    const matches = matchingWatches(chat.priceWatches, query);
    if (matches.length === 0) {
      return { status: "missing", skipSave: true };
    }
    if (matches.length > 1) {
      return { status: "ambiguous", matches, skipSave: true };
    }

    const removed = matches[0];
    chat.priceWatches = chat.priceWatches.filter((item) => item !== removed);
    return { status: "removed", watch: removed };
  });

  if (outcome.status === "missing") {
    await sendMessage(message.chat.id, `You are not watching <code>${escapeHtml(query)}</code>.`);
    return;
  }
  if (outcome.status === "ambiguous") {
    await sendMessage(message.chat.id, ambiguousWatchText(outcome.matches));
    return;
  }

  const label = outcome.watch.symbol || outcome.watch.query;
  await sendMessage(message.chat.id, `Stopped watching <b>${escapeHtml(label)}</b>.`);
}

function startPriceAlertLoop() {
  const loop = async () => {
    while (true) {
      await sleep(priceCheckIntervalMs);
      try {
        await runPriceChecks();
      } catch (error) {
        console.error("Price check error:", error.message);
      }
    }
  };

  loop();
}

async function runPriceChecks() {
  const state = await readState();
  const tracked = [];
  const seenKeys = new Set();

  for (const chat of Object.values(state.chats || {})) {
    for (const watch of chat.priceWatches || []) {
      if (!watch?.query) {
        continue;
      }
      const key = watchLookupKey(watch);
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);
      tracked.push({
        key,
        query: watch.query,
        chainId: watch.chainId || "",
        tokenAddress: watch.tokenAddress || "",
        symbol: watch.symbol || "",
      });
    }
  }

  if (tracked.length === 0) {
    return;
  }

  const quotes = new Map();
  for (let index = 0; index < tracked.length; index += 1) {
    const item = tracked[index];
    const label = String(item.symbol || item.query).slice(0, 80);
    try {
      const pair = await findTrackedPair(item);
      const price = Number(pair?.priceUsd);
      if (!pair || !Number.isFinite(price) || price <= 0 || !quoteMatchesTracked(item, pair)) {
        console.error(`DexScreener price check failed for ${label}: no pair`);
      } else {
        quotes.set(item.key, { pair, price });
      }
    } catch (error) {
      console.error(`DexScreener price check failed for ${label}: ${error.message}`);
    }

    if (index < tracked.length - 1) {
      await sleep(priceCheckGapMs);
    }
  }

  if (quotes.size === 0) {
    return;
  }

  const outcome = await mutateState((fresh) => {
    const events = [];
    let changed = false;

    for (const [chatId, rawChat] of Object.entries(fresh.chats || {})) {
      if (!rawChat?.priceWatches?.length) {
        continue;
      }
      const chat = ensureChatState(fresh, chatId);
      const alertsOn = chat.alerts !== false;

      for (const watch of chat.priceWatches) {
        if (!watch.id) {
          watch.id = randomUUID();
          changed = true;
        }
        if (typeof watch.revision !== "number") {
          watch.revision = 0;
          changed = true;
        }

        const quote = quoteForWatch(watch, quotes);
        if (!quote || !quoteMatchesTracked(watch, quote.pair)) {
          continue;
        }

        const previousAbove = watch.aboveSeenPrice;
        const previousBelow = watch.belowSeenPrice;
        if (!applyPairSnapshot(watch, quote.pair)) {
          continue;
        }
        changed = true;

        if (watch.above != null) {
          const crossed =
            alertsOn &&
            !watch.aboveFired &&
            typeof previousAbove === "number" &&
            previousAbove < watch.above &&
            quote.price >= watch.above;
          if (crossed) {
            events.push(priceAlertEvent(chatId, watch, "above", watch.above, quote.price));
          } else {
            watch.aboveSeenPrice = quote.price;
          }
        }

        if (watch.below != null) {
          const crossed =
            alertsOn &&
            !watch.belowFired &&
            typeof previousBelow === "number" &&
            previousBelow > watch.below &&
            quote.price <= watch.below;
          if (crossed) {
            events.push(priceAlertEvent(chatId, watch, "below", watch.below, quote.price));
          } else {
            watch.belowSeenPrice = quote.price;
          }
        }
      }
    }

    return { events, skipSave: !changed };
  });

  for (const event of outcome.events) {
    try {
      await sendMessage(event.chatId, formatPriceAlert(event));
    } catch (error) {
      console.error(`Price alert delivery failed for chat ${event.chatId}: ${error.message}`);
      continue;
    }

    try {
      await mutateState((fresh) => {
        const watch = findPriceWatch(fresh, event.chatId, event.watchId);
        if (!watch || !sameAlertRevision(watch, event)) {
          return { skipSave: true };
        }
        if (event.direction === "above") {
          if (watch.above !== event.target) {
            return { skipSave: true };
          }
          watch.aboveFired = true;
          watch.aboveSeenPrice = event.price;
        } else {
          if (watch.below !== event.target) {
            return { skipSave: true };
          }
          watch.belowFired = true;
          watch.belowSeenPrice = event.price;
        }
        return { skipSave: false };
      });
    } catch (markError) {
      console.error(`Price alert mark-fired failed for chat ${event.chatId}: ${markError.message}`);
    }
    await sleep(60);
  }
}

function parseWatchCommand(args) {
  if (!Array.isArray(args) || args.length === 0) {
    return { error: "usage" };
  }

  const keywords = new Set(["above", "below", "rearm", ">", "<"]);
  const tokenParts = [];
  let index = 0;
  for (; index < args.length; index += 1) {
    if (keywords.has(String(args[index]).toLowerCase())) {
      break;
    }
    tokenParts.push(args[index]);
  }

  const query = tokenParts.join(" ").trim();
  if (!query) {
    return { error: "usage" };
  }

  let above;
  let below;
  let rearm = false;
  let clearAbove = false;
  let clearBelow = false;

  while (index < args.length) {
    const word = String(args[index]).toLowerCase();
    if (word === "rearm") {
      rearm = true;
      index += 1;
      continue;
    }

    if (word === "above" || word === ">" || word === "below" || word === "<") {
      const which = word === "above" || word === ">" ? "above" : "below";
      const raw = args[index + 1];
      if (!raw) {
        return { error: "usage" };
      }
      if (["off", "none", "clear"].includes(String(raw).toLowerCase())) {
        if (which === "above") {
          clearAbove = true;
          above = undefined;
        } else {
          clearBelow = true;
          below = undefined;
        }
        index += 2;
        continue;
      }

      const value = parseUsd(raw);
      if (value === null) {
        return { error: "price", which };
      }
      if (which === "above") {
        above = value;
        clearAbove = false;
      } else {
        below = value;
        clearBelow = false;
      }
      index += 2;
      continue;
    }

    return { error: "usage" };
  }

  return { query, above, below, rearm, clearAbove, clearBelow };
}

function parseUsd(raw) {
  const cleaned = String(raw).trim().replace(/^\$/, "").replaceAll(",", "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) {
    return null;
  }
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

function blankPriceWatch(query) {
  return {
    id: randomUUID(),
    revision: 0,
    updatedAt: null,
    query,
    symbol: null,
    name: null,
    chainId: null,
    tokenAddress: null,
    pairAddress: null,
    chartUrl: null,
    above: null,
    below: null,
    aboveFired: false,
    belowFired: false,
    aboveSeenPrice: null,
    belowSeenPrice: null,
    lastPriceUsd: null,
    lastCheckedAt: null,
  };
}

function applyPairSnapshot(watch, pair) {
  const price = Number(pair?.priceUsd);
  if (!Number.isFinite(price) || price <= 0) {
    return false;
  }
  if (!pair?.chainId || !pair?.baseToken?.address) {
    return false;
  }
  if (watch.chainId && watch.tokenAddress && !sameToken(watch, pair)) {
    return false;
  }

  watch.lastPriceUsd = price;
  watch.lastCheckedAt = new Date().toISOString();
  watch.symbol = pair.baseToken.symbol || watch.symbol || null;
  watch.name = pair.baseToken.name || watch.name || null;
  if (!watch.chainId || !watch.tokenAddress) {
    watch.chainId = pair.chainId;
    watch.tokenAddress = pair.baseToken.address;
  }
  watch.pairAddress = pair.pairAddress || watch.pairAddress || null;
  watch.chartUrl = pair.url || watch.chartUrl || null;
  return true;
}

function rearmWatch(watch, freshPrice) {
  if (typeof freshPrice !== "number") {
    return;
  }
  if (watch.above != null) {
    watch.aboveFired = false;
    watch.aboveSeenPrice = freshPrice;
  }
  if (watch.below != null) {
    watch.belowFired = false;
    watch.belowSeenPrice = freshPrice;
  }
}

function bumpWatchRevision(watch) {
  watch.revision = (typeof watch.revision === "number" ? watch.revision : 0) + 1;
  watch.updatedAt = new Date().toISOString();
}

function freshTrackedPrice(watch, pair) {
  const price = Number(pair?.priceUsd);
  if (!pair || !Number.isFinite(price) || price <= 0) {
    return null;
  }
  if (!pair.chainId || !pair.baseToken?.address) {
    return null;
  }
  if (watch?.chainId && watch?.tokenAddress && !sameToken(watch, pair)) {
    return null;
  }
  return price;
}

function targetNotArmedText(query, lookupError) {
  return [
    "<b>Price target not armed</b>",
    `The live price for <code>${escapeHtml(query)}</code> could not be checked, so the target was not armed.`,
    lookupError?.message ? `Reason: ${escapeHtml(lookupError.message)}` : "",
    "Nothing was changed.",
  ].filter(Boolean).join("\n");
}

function priceAlertEvent(chatId, watch, direction, target, price) {
  return {
    chatId,
    watchId: watch.id,
    revision: typeof watch.revision === "number" ? watch.revision : 0,
    updatedAt: watch.updatedAt || null,
    direction,
    target,
    price,
    watch: { ...watch },
  };
}

function findPriceWatch(state, chatId, watchId) {
  if (!watchId) {
    return null;
  }
  const watches = state.chats?.[String(chatId)]?.priceWatches;
  if (!Array.isArray(watches)) {
    return null;
  }
  return watches.find((item) => item?.id === watchId) || null;
}

function sameAlertRevision(watch, event) {
  const revision = typeof watch.revision === "number" ? watch.revision : 0;
  return revision === event.revision && (watch.updatedAt || null) === (event.updatedAt || null);
}

function matchingWatches(watches, query) {
  const key = normalizeKey(query);
  if (!key || !Array.isArray(watches)) {
    return [];
  }
  const exact = watches.filter(
    (watch) => normalizeKey(watch?.query) === key || normalizeKey(watch?.tokenAddress) === key,
  );
  if (exact.length > 0) {
    return exact;
  }
  return watches.filter((watch) => watch?.symbol && normalizeKey(watch.symbol) === key);
}

function sameToken(watch, pair) {
  if (!watch?.tokenAddress || !pair?.baseToken?.address) {
    return false;
  }
  if (normalizeKey(watch.tokenAddress) !== normalizeKey(pair.baseToken.address)) {
    return false;
  }
  if (watch.chainId && pair.chainId && normalizeKey(watch.chainId) !== normalizeKey(pair.chainId)) {
    return false;
  }
  return true;
}

function watchLookupKey(watch) {
  if (watch.chainId && watch.tokenAddress) {
    return `pair:${normalizeKey(watch.chainId)}:${normalizeKey(watch.tokenAddress)}`;
  }
  return `query:${normalizeKey(watch.query)}`;
}

function quoteForWatch(watch, quotes) {
  return quotes.get(watchLookupKey(watch)) || null;
}

function quoteMatchesTracked(watch, pair) {
  if (!pair?.chainId || !pair?.baseToken?.address) {
    return false;
  }
  if (watch?.chainId && watch?.tokenAddress) {
    return sameToken(watch, pair);
  }
  return true;
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function watchUsageText() {
  return [
    "Usage:",
    "/watch &lt;token&gt;",
    "/watch &lt;token&gt; above &lt;usd&gt;",
    "/watch &lt;token&gt; below &lt;usd&gt;",
    "/watch &lt;token&gt; above &lt;usd&gt; below &lt;usd&gt;",
    "/watch &lt;token&gt; rearm",
    "/watch &lt;token&gt; above off",
    "",
    "Example: /watch PEPE above 0.00002 below 0.00001",
    "BLARC messages this chat once when price crosses a target, if /alerts is on. No trade is placed.",
  ].join("\n");
}

function ambiguousWatchText(matches) {
  const lines = matches.map((watch, index) => {
    const symbol = watch.symbol ? ` (${escapeHtml(watch.symbol)})` : "";
    return `${index + 1}. <code>${escapeHtml(watch.query)}</code>${symbol}`;
  });
  return ["That matches more than one price watch. Use the original query:", "", ...lines].join("\n");
}

function formatWatchConfirmation(watch, status, alertsOn) {
  const label = watch.symbol || watch.query;
  const name = watch.name && watch.name !== label ? `${watch.name} (${label})` : label;
  return [
    status === "created" ? `<b>Watching ${escapeHtml(name)}</b>` : `<b>Updated ${escapeHtml(name)}</b>`,
    watch.chainId ? `Chain: <b>${escapeHtml(watch.chainId)}</b>` : "",
    watch.tokenAddress ? `Token: <code>${escapeHtml(watch.tokenAddress)}</code>` : `Watch: <code>${escapeHtml(watch.query)}</code>`,
    `Last price: <b>${formatUsd(watch.lastPriceUsd)}</b>`,
    `Above: <b>${formatTarget(watch.above, watch.aboveFired)}</b>`,
    `Below: <b>${formatTarget(watch.below, watch.belowFired)}</b>`,
    "",
    alertsOn
      ? "Alerts are ON. You get one message when price crosses an armed target."
      : "Alerts are OFF for this chat. The watch is saved, but nothing will be sent until /alerts on.",
    "Re-arm a fired target with /watch " + escapeHtml(watch.query) + " rearm.",
    "This does not place a trade.",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatPriceAlert(event) {
  const watch = event.watch;
  const label = watch.symbol || watch.query;
  const name = watch.name && watch.name !== label ? `${watch.name} (${label})` : label;
  const direction = event.direction === "above" ? "above" : "below";
  return [
    "<b>BLARC Price Alert</b>",
    `<b>${escapeHtml(name)}</b> crossed ${direction} ${formatUsd(event.target)}.`,
    `Price: <b>${formatUsd(event.price)}</b>`,
    watch.chainId ? `Chain: <b>${escapeHtml(watch.chainId)}</b>` : "",
    watch.tokenAddress ? `Token: <code>${escapeHtml(watch.tokenAddress)}</code>` : `Watch: <code>${escapeHtml(watch.query)}</code>`,
    watch.chartUrl ? `Chart: ${escapeHtml(watch.chartUrl)}` : "",
    "",
    "This target has fired once and will stay quiet.",
    `Set a new level with /watch ${escapeHtml(watch.query)} ${direction} &lt;usd&gt; or re-arm with /watch ${escapeHtml(watch.query)} rearm.`,
    "BLARC does not place trades.",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatTarget(value, fired) {
  if (value == null) {
    return "not set";
  }
  return `${formatUsd(value)} (${fired ? "fired" : "armed"})`;
}

function formatCheckedAt(iso) {
  if (!iso) {
    return "not yet";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "not yet";
  }
  return `${new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Lagos",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)} WAT`;
}


async function addWallet(message, args, options) {
  const wallet = args[0];
  if (!wallet) {
    await sendMessage(message.chat.id, options.emptyUsage);
    return;
  }

  const validation = validateAddress(wallet);
  if (!validation.valid) {
    await sendMessage(message.chat.id, `That does not look like a supported wallet address yet.\nReason: ${validation.reason}`);
    return;
  }

  const outcome = await mutateState((state) => {
    const chat = ensureChatState(state, message.chat.id);
    if (chat.watchlist.includes(wallet)) {
      return { status: "exists" };
    }
    if (chat.watchlist.length >= 20) {
      return { status: "limit", skipSave: true };
    }
    chat.watchlist.push(wallet);
    return { status: "added" };
  });

  if (outcome.status === "limit") {
    await sendMessage(message.chat.id, "Wallet limit reached. Remove one with /remove_wallet &lt;wallet&gt; before adding more.");
    return;
  }

  const explorer = buildExplorerLink(wallet, validation.chain);
  await sendMessage(
    message.chat.id,
    [
      `${options.savedPrefix}: <code>${escapeHtml(wallet)}</code>`,
      `Network type: <b>${escapeHtml(validation.chain)}</b>`,
      explorer ? `Explorer: ${escapeHtml(explorer)}` : "",
      "",
      "This is read-only. BLARC cannot move funds from this wallet.",
      "Use /wallets to view saved wallets.",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}


async function listWallets(message) {
  const state = await readState();
  const chat = state.chats?.[String(message.chat.id)] || { watchlist: [] };
  chat.watchlist ||= [];

  if (chat.watchlist.length === 0) {
    await sendMessage(message.chat.id, "Your BLARC wallet list is empty. Add one with /wallet &lt;public-wallet-address&gt;.");
    return;
  }

  const wallets = chat.watchlist.map((wallet, index) => {
    const validation = validateAddress(wallet);
    const explorer = buildExplorerLink(wallet, validation.chain);
    return [`${index + 1}. <code>${escapeHtml(wallet)}</code>`, `   ${escapeHtml(validation.chain)}${explorer ? ` - ${escapeHtml(explorer)}` : ""}`].join(
      "\n",
    );
  });

  await sendMessage(
    message.chat.id,
    [
      "<b>Your read-only BLARC wallets</b>",
      "",
      ...wallets,
      "",
      "Remove one with /remove_wallet &lt;address&gt;.",
      "These are public addresses only. No private keys are stored.",
    ].join("\n"),
  );
}


async function removeWallet(message, args, options) {
  const wallet = args[0];
  if (!wallet) {
    await sendMessage(message.chat.id, options.emptyUsage);
    return;
  }

  const removed = await mutateState((state) => {
    const chat = ensureChatState(state, message.chat.id);
    const before = chat.watchlist.length;
    chat.watchlist = chat.watchlist.filter((item) => item.toLowerCase() !== wallet.toLowerCase());
    const didRemove = before !== chat.watchlist.length;
    return { didRemove, skipSave: !didRemove };
  });

  await sendMessage(
    message.chat.id,
    removed.didRemove ? `Removed <code>${escapeHtml(wallet)}</code>.` : "That wallet was not saved.",
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

function buildExplorerLink(wallet, chain) {
  if (chain === "EVM") {
    return `https://etherscan.io/address/${wallet}`;
  }

  if (chain === "Solana/Base58") {
    return `https://solscan.io/account/${wallet}`;
  }

  return "";
}

async function handleAlerts(message, args) {
  const mode = args[0]?.toLowerCase();
  if (!["on", "off"].includes(mode)) {
    await sendMessage(message.chat.id, "Usage: /alerts on or /alerts off");
    return;
  }

  await mutateState((state) => {
    const chat = ensureChatState(state, message.chat.id);
    chat.alerts = mode === "on";
  });
  await sendMessage(
    message.chat.id,
    mode === "on"
      ? "BLARC alerts are now <b>ON</b>. Armed price targets will message this chat once when price crosses them."
      : "BLARC alerts are now <b>OFF</b>. Price watches stay saved, but this chat will not receive them.",
  );
}

async function handleSettings(message) {
  const state = await readState();
  const chat = state.chats?.[String(message.chat.id)];
  const alertsOn = chat ? chat.alerts !== false : true;
  const walletCount = chat?.watchlist?.length || 0;
  const watchCount = chat?.priceWatches?.length || 0;
  await sendMessage(
    message.chat.id,
    [
      "<b>BLARC Settings</b>",
      `Alerts: <b>${alertsOn ? "ON" : "OFF"}</b>`,
      `Price watches: <b>${watchCount}</b>/${maxPriceWatches}`,
      `Wallets: <b>${walletCount}</b>/20`,
      formatConnectedWallet(chat?.wallet),
      "",
      "Price targets: /watch &lt;token&gt; above &lt;usd&gt; or below &lt;usd&gt;.",
      "Change delivery with /alerts on or /alerts off.",
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
      "Wallet pairing is non-custodial: /connect saves a public address only. /swap previews a 1% in-swap fee and does not broadcast.",
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

  const state = await readState();
  const chatIds = Object.keys(state.chats || {});
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

async function sendPlain(chatId, text) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
}

async function sendPhoto(chatId, png, caption) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption);
  form.append("photo", new Blob([png], { type: "image/png" }), "blarc-connect.png");
  const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: "POST",
    body: form,
  });
  const data = await response.json();
  if (!data.ok) {
    throw new Error(data.description || "Telegram sendPhoto failed");
  }
  return data.result;
}

function formatConnectedWallet(wallet) {
  const connected = sanitizeWallet(wallet);
  if (!connected) {
    return "Connected wallet: <b>not connected</b> (/connect)";
  }
  return `Connected wallet: <code>${escapeHtml(connected.address)}</code> (${escapeHtml(connected.chainId)})`;
}

async function upsertChat(chatId, defaults = {}) {
  await mutateState((state) => {
    const chat = ensureChatState(state, chatId);
    Object.assign(chat, { ...defaults, ...chat });
  });
}

function withStateLock(fn) {
  const run = stateLock.then(fn, fn);
  stateLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function readState() {
  return withStateLock(() => loadState());
}

async function mutateState(mutator) {
  return withStateLock(async () => {
    const state = await loadState();
    const result = await mutator(state);
    if (!result?.skipSave) {
      await saveState(state);
    }
    return result;
  });
}

function ensureChatState(state, chatId) {
  const key = String(chatId);
  state.chats[key] ||= {
    alerts: true,
    watchlist: [],
    priceWatches: [],
  };

  state.chats[key].watchlist ||= [];
  state.chats[key].priceWatches ||= [];
  state.chats[key].alerts = state.chats[key].alerts !== false;
  if (state.chats[key].wallet) {
    state.chats[key].wallet = sanitizeWallet(state.chats[key].wallet);
  }
  for (const watch of state.chats[key].priceWatches) {
    if (!watch || typeof watch !== "object") {
      continue;
    }
    if (!watch.id) {
      watch.id = randomUUID();
    }
    if (typeof watch.revision !== "number") {
      watch.revision = 0;
    }
  }
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
  const tmpPath = `${statePath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tmpPath, statePath);
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
