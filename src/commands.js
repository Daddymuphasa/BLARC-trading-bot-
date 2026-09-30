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
import { buildMarketRiskLines, classifyAddress, findBestPair, formatPairSummary } from "./dexscreener.js";
import { adminIds, maxPriceWatches, supportUrl, updatesUrl } from "./config.js";
import { ensureChatState, mutateState, readState, upsertChat } from "./state.js";
import { escapeHtml, sendMessage, sendPhoto, sendPlain, sleep } from "./telegram.js";
import { handleAlerts, handleUnwatch, handleWatch, handleWatchlist } from "./alerts.js";
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
  settings: handleSettings,
  support: handleSupport,
  about: handleAbout,
  broadcast: handleBroadcast,
};

export async function handleUpdate(update) {
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

function formatConnectedWallet(wallet) {
  const connected = sanitizeWallet(wallet);
  if (!connected) {
    return "Connected wallet: <b>not connected</b> (/connect)";
  }
  return `Connected wallet: <code>${escapeHtml(connected.address)}</code> (${escapeHtml(connected.chainId)})`;
}
