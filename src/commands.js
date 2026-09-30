import {
  adoptSession,
  beginPairing,
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
import { buildMarketRiskLines, classifyAddress, findBestPair, formatPairSummary } from "./dexscreener.js";
import { adminIds, maxPriceWatches, supportUrl, twitterUrl, updatesUrl } from "./config.js";
import { ensureChatState, mutateState, readState, upsertChat } from "./state.js";
import { escapeHtml, sendGuide, sendMessage, sendPhoto, sendPlain, sleep } from "./telegram.js";
import { handleAlerts, handleUnwatch, handleWatch, handleWatchlist } from "./alerts.js";
import { ensurePairCard } from "./cards.js";
import { executeSwap, swapApiKey } from "./swap.js";
import { formatCopyStatus, handleAuto, handleCopy, handleCopyCallback, handleCopies, handleGoal, handleRisk, handleUncopy } from "./copy.js";
import process from "node:process";

const pairingGeneration = new Map();

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
  copy: handleCopy,
  copies: handleCopies,
  uncopy: handleUncopy,
  auto: handleAuto,
  goal: handleGoal,
  risk: handleRisk,
  settings: handleSettings,
  support: handleSupport,
  about: handleAbout,
  broadcast: handleBroadcast,
};

export async function handleUpdate(update) {
  if (update.callback_query) {
    await handleCopyCallback(update.callback_query);
    return;
  }

  const message = update.message;
  if (!message?.chat?.id || !message.text) {
    return;
  }

  if (looksLikeSecretMaterial(message.text)) {
    await sendMessage(message.chat.id, "That looks like a seed phrase or private key. BLARC does not accept it. Nothing was saved.");
    return;
  }

  const parsed = parseCommand(message.text);
  if (!parsed) {
    const trimmed = message.text.trim();
    if (!/\s/.test(trimmed) && classifyAddress(trimmed).valid) {
      await handleCopy(message, [trimmed]);
      return;
    }
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
  await sendGuide(message.chat.id, "welcome.jpg", "Welcome. Paste a wallet, set an alert, or connect to trade.");
  await sendMessage(
    message.chat.id,
    [
      `Welcome to <b>BLARC</b>, ${name}.`,
      "Paste a wallet to copy a trader. Set a price alert. Connect your wallet to trade.",
      "",
      "/connect — pair your wallet",
      "/disconnect — forget the address",
      "/fee — 1% fee wallet",
      "/swap — sign a swap",
      "/wallet — save a public address",
      "/copy — watch a trader",
      "/wallets — saved addresses",
      "/scan — token check",
      "/watch — price alert",
      "/watchlist — your alerts",
      "/price — live price",
      "/settings — preferences",
      "/support — official links",
      "",
      "BLARC never asks for a seed phrase or private key.",
    ].join("\n"),
  );
}

async function handleHelp(message) {
  await sendGuide(message.chat.id, "help.jpg", "Help: /copy, /alerts, /swap, /goal, /risk, /fee.");
  await sendMessage(
    message.chat.id,
    [
      "<b>BLARC</b>",
      "/start — welcome",
      "/connect — pair wallet",
      "/disconnect — forget address",
      "/fee — 1% fee wallet",
      "/swap — sign a swap",
      "/wallet — save address",
      "/wallets — list addresses",
      "/remove_wallet — remove address",
      "/copy — watch a wallet",
      "/copies — your watches",
      "/uncopy — stop a watch",
      "/auto — auto-ask to sign",
      "/goal — weekly goal",
      "/risk — risk tier",
      "/scan — token check",
      "/watch — price target",
      "/watch rearm — arm targets again",
      "/unwatch — remove target",
      "/watchlist — targets",
      "/price — live price",
      "/alerts — alerts on or off",
      "/settings — preferences",
      "/support — links",
      "/about — status",
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
      "Use /swap to sign a trade in your wallet. The 1% fee is inside that transaction, or nothing is sent.",
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
      "No fee wallet is set. Fee cannot be included, swap not sent.",
    );
    return;
  }
  if (status.state !== "ok") {
    await sendMessage(
      message.chat.id,
      "A fee wallet value is present, but it is not a valid public address for its chain, so it is not used. Fee cannot be included, swap not sent.",
    );
    return;
  }
  const lines = [
    "<b>BLARC swap fee</b>",
    "Cut: <b>1%</b> (100 bps) of the sell amount, in that token, inside the one transaction you sign.",
    "BLARC does not take custody and does not sign.",
    "",
    "Which wallet is paid depends on the connected chain. If that wallet is missing, the swap is refused.",
  ];
  lines.push(
    status.evm
      ? `EVM chains other than Arc and Robinhood: <code>${escapeHtml(status.evm)}</code>`
      : "EVM fee wallet is not set. Those swaps are refused.",
  );
  lines.push(
    status.robinhood
      ? `Robinhood (chain 4663): <code>${escapeHtml(status.robinhood)}</code>`
      : "Robinhood fee wallet is not set. Those swaps are refused.",
  );
  lines.push(
    status.arc
      ? `Arc (chain 5042): <code>${escapeHtml(status.arc)}</code>`
      : "Arc fee wallet is not set. Those swaps are refused.",
  );
  lines.push(
    status.sol
      ? `Solana: <code>${escapeHtml(status.sol)}</code>`
      : "Solana fee wallet is not set.",
  );
  lines.push("Solana swaps are refused. The 1% cannot be put in the same Solana transaction here, so nothing is signed.");
  lines.push(
    swapApiKey()
      ? "On Arc, Robinhood, and other supported EVM chains, /swap asks your wallet to sign only when the quote puts this 1% in that transaction."
      : "ZEROX_API_KEY is not set. Fee cannot be included, swap not sent.",
  );
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
    await sendGuide(
      message.chat.id,
      "trade.jpg",
      "You sign every swap. If the 1% fee cannot be included, nothing is sent.",
    );
    await sendMessage(
      message.chat.id,
      "Usage: /swap &lt;amount&gt; &lt;from-token&gt; &lt;to-token&gt;\nExample: /swap 100 USDC ETH\nThe 1% fee has to be inside the transaction you sign. Otherwise nothing is sent.",
    );
    return;
  }

  const reply = await executeSwap({
    chatId: message.chat.id,
    wallet,
    amount: parsed.amount,
    tokenIn: parsed.tokenIn,
    tokenOut: parsed.tokenOut,
  });
  await sendMessage(message.chat.id, reply);
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

    if (classifyAddress(target).valid) {
      await ensurePairCard(pair);
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
      formatCopyStatus(chat),
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
      twitterUrl ? `Twitter: ${escapeHtml(twitterUrl)}` : "Twitter: handle not set yet",
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
      "Wallet pairing is non-custodial: /connect saves a public address only. /swap asks your wallet to sign. BLARC never holds a key.",
      "A swap is requested only when the 1% fee is inside that same transaction. Otherwise nothing is sent. Solana swaps are refused.",
      "Copy trading watches a public wallet. Auto still asks you to sign. BLARC does not sign and does not hold a key.",
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

function formatConnectedWallet(wallet) {
  const connected = sanitizeWallet(wallet);
  if (!connected) {
    return "Connected wallet: <b>not connected</b> (/connect)";
  }
  return `Connected wallet: <code>${escapeHtml(connected.address)}</code> (${escapeHtml(connected.chainId)})`;
}
