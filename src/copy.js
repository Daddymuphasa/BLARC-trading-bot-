import { randomBytes, randomUUID } from "node:crypto";
import { classifyAddress } from "./dexscreener.js";
import { copyPollIntervalMs, evmRpcConfigured, evmRpcUrl, maxCopyWatches, solanaRpcConfigured, solanaRpcUrl } from "./config.js";
import { ensureChatState, mutateState, readState } from "./state.js";
import { savedCardForTrade } from "./cards.js";
import { escapeHtml, sendGuide, sendMessage, sendPhotoFile, sleep, telegram } from "./telegram.js";
import { executeSwap } from "./swap.js";
import { ROBINHOOD_CHAIN_ID, SOLANA_SENTINEL_CHAIN_ID, chainIdNumber, isEvmAddress, isSolanaAddress, looksLikeSecretMaterial, sanitizeWallet } from "./wallet.js";

const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TIERS = ["low", "average", "high", "daredevil"];
const TIER_LABEL = { low: "Low", average: "Average", high: "High", daredevil: "Daredevil" };
const PENDING_MS = 15 * 60 * 1000;
const SOL_DUST = 1_000_000n;
const MAX_EVM_BLOCKS = 20;
const MAX_EVM_GAP = 400n;
const MAX_RECEIPTS = 8;
const MAX_SOL_SIGS = 5;

const decimalsCache = new Map();
let evmDecimalsChain = null;
let skippedForeignEvmChain = false;

export function startCopyWatchLoop() {
  const loop = async () => {
    while (true) {
      try {
        await pollCopyWatches();
      } catch (error) {
        console.error("Copy watch error:", redact(error?.message));
      }
      await sleep(copyPollIntervalMs);
    }
  };
  loop();
}

export async function handleCopy(message, args) {
  const chatId = message.chat.id;
  const text = args.join(" ").trim();
  if (!text) {
    await sendGuide(chatId, "copy.jpg", "Paste a public wallet. Tap Copy or Skip. Auto still asks you to sign.");
    await sendMessage(chatId, "Paste a public wallet.\n/copy &lt;address&gt;\nSolana or EVM is detected. Seeds and private keys are rejected.");
    return;
  }
  if (looksLikeSecretMaterial(text)) {
    await sendMessage(chatId, secretRejection());
    return;
  }
  if (args.length !== 1) {
    await sendMessage(chatId, "Paste one public address. Example: /copy 0xabc...");
    return;
  }
  await saveCopyWatch(chatId, args[0].trim());
}

export async function handleCopies(message) {
  const state = await readState();
  const chat = state.chats?.[String(message.chat.id)];
  await sendGuide(message.chat.id, "copy.jpg", "Paste a public wallet. Tap Copy or Skip. Auto still asks you to sign.");
  await sendMessage(message.chat.id, formatCopyStatus(chat, { list: true }));
}

export async function handleUncopy(message, args) {
  const chatId = message.chat.id;
  const state = await readState();
  const watches = state.chats?.[String(chatId)]?.copyWatches || [];
  const target = resolveWatch(watches, args[0]);
  if (target.error) {
    await sendMessage(chatId, target.error);
    return;
  }
  await mutateState((state) => {
    const chat = ensureChatState(state, chatId);
    chat.copyWatches = chat.copyWatches.filter((watch) => watch.id !== target.watch.id);
    chat.pendingCopies = (chat.pendingCopies || []).filter((pending) => pending.address !== target.watch.address);
  });
  await sendMessage(chatId, `Stopped watching <code>${escapeHtml(target.watch.address)}</code>. Nothing was traded.`);
}

export async function handleAuto(message, args) {
  const chatId = message.chat.id;
  const state = await readState();
  const watches = state.chats?.[String(chatId)]?.copyWatches || [];
  const parsed = parseAutoArgs(watches, args);
  if (parsed.error) {
    await sendMessage(chatId, parsed.error);
    return;
  }
  await mutateState((state) => {
    const chat = ensureChatState(state, chatId);
    const watch = chat.copyWatches.find((item) => item.id === parsed.watch.id);
    if (watch) {
      watch.auto = parsed.on;
    }
  });
  await sendMessage(
    chatId,
    parsed.on
      ? `Auto on for <code>${escapeHtml(parsed.watch.address)}</code>. BLARC does not sign. A copy still asks your wallet to sign the fee-aware swap. No wallet means no trade.`
      : `Auto off for <code>${escapeHtml(parsed.watch.address)}</code>. New trades will ask Copy or Skip.`,
  );
}

export async function handleGoal(message, args) {
  const chatId = message.chat.id;
  if (args.length === 0) {
    const state = await readState();
    await sendMessage(chatId, goalText(state.chats?.[String(chatId)]?.weeklyGoalPercent));
    return;
  }
  if (args.length === 1 && args[0].toLowerCase() === "off") {
    await mutateState((state) => {
      ensureChatState(state, chatId).weeklyGoalPercent = null;
    });
    await sendMessage(chatId, "Weekly goal cleared. Profit tracking is not live yet.");
    return;
  }
  const percent = parseGoal(args[0]);
  if (args.length !== 1 || percent == null) {
    await sendMessage(chatId, "Usage: /goal 40\nThat stores 40% of the account as the weekly goal. It does not read a balance.");
    return;
  }
  await mutateState((state) => {
    ensureChatState(state, chatId).weeklyGoalPercent = percent;
  });
  await sendMessage(chatId, goalText(percent));
}

export async function handleRisk(message, args) {
  const chatId = message.chat.id;
  if (args.length === 0) {
    const state = await readState();
    await sendMessage(chatId, riskText(state.chats?.[String(chatId)]));
    return;
  }
  const head = args[0].toLowerCase();
  if (head === "max") {
    await setRiskMax(chatId, args.slice(1));
    return;
  }
  const tier = normalizeTier(head);
  if (args.length !== 1 || !tier) {
    await sendMessage(chatId, "Usage: /risk low, /risk average, /risk high, or /risk daredevil.\nOptional size cap: /risk max 100");
    return;
  }
  await mutateState((state) => {
    ensureChatState(state, chatId).riskTier = tier;
  });
  const state = await readState();
  await sendMessage(chatId, `Risk set to <b>${TIER_LABEL[tier]}</b>.\n${riskText(state.chats?.[String(chatId)])}`);
}

export async function handleCopyCallback(callback) {
  const chatId = callback?.message?.chat?.id;
  const data = String(callback?.data || "");
  const action = data.startsWith("cp:") ? "copy" : data.startsWith("sk:") ? "skip" : null;
  if (!action || !chatId) {
    await answerCallback(callback?.id, "That button is not active.");
    return;
  }
  const taken = await takePending(chatId, data.slice(3));
  await clearButtons(chatId, callback?.message?.message_id);
  if (!taken.pending) {
    await answerCallback(callback.id, taken.reason);
    await sendMessage(chatId, escapeHtml(taken.reason));
    return;
  }
  if (action === "skip") {
    await answerCallback(callback.id, "Skipped");
    await sendMessage(chatId, "Skipped. Nothing was sent.");
    return;
  }
  await answerCallback(callback.id, "Copy");
  const reply = await performCopy(chatId, taken.pending);
  await sendMessage(chatId, reply);
}

export function formatCopyStatus(chat, options = {}) {
  const watches = Array.isArray(chat?.copyWatches) ? chat.copyWatches : [];
  const lines = ["<b>Copy</b>", `Watches: <b>${watches.length}</b>/${maxCopyWatches}`];
  if (options.list) {
    if (watches.length === 0) {
      lines.push("None yet. Paste a public wallet or use /copy &lt;address&gt;.");
    } else {
      watches.forEach((watch, index) => {
        lines.push(`${index + 1}. <code>${escapeHtml(watch.address)}</code>`);
        lines.push(`   ${escapeHtml(watch.chain)} · Auto ${watch.auto ? "on" : "off"}`);
      });
    }
  }
  lines.push(goalText(chat?.weeklyGoalPercent));
  lines.push(riskText(chat));
  if (watches.some((watch) => watch.chain === "EVM")) {
    lines.push(
      evmRpcConfigured()
        ? "EVM watching uses BLARC_EVM_RPC_URL."
        : "EVM watching uses the public Robinhood RPC.",
    );
  }
  if (watches.some((watch) => watch.chain === "Solana")) {
    lines.push(
      solanaRpcConfigured()
        ? "Solana watching uses BLARC_SOLANA_RPC_URL. A copy asks you to sign the 1% fee swap."
        : "Solana watching uses the public Solana RPC. A copy asks you to sign the 1% fee swap.",
    );
  }
  lines.push("BLARC holds no keys. A copy is sent only through the fee-aware swap you sign.");
  return lines.join("\n");
}

export function parseGoal(raw) {
  const text = String(raw || "").trim().replace(/%$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    return null;
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0 || value > 10000) {
    return null;
  }
  return value;
}

export function normalizeTier(value) {
  const tier = String(value || "").trim().toLowerCase();
  return TIERS.includes(tier) ? tier : null;
}

export function tierFromSize(amount, max) {
  const sell = parseDecimal(amount);
  const cap = parseDecimal(max);
  if (!sell || !cap) {
    return null;
  }
  const scale = BigInt(Math.max(sell.scale, cap.scale));
  const sellValue = sell.value * 10n ** (scale - BigInt(sell.scale));
  const capValue = cap.value * 10n ** (scale - BigInt(cap.scale));
  if (sellValue <= 0n || capValue <= 0n) {
    return null;
  }
  if (sellValue * 4n <= capValue) {
    return "low";
  }
  if (sellValue * 2n <= capValue) {
    return "average";
  }
  if (sellValue <= capValue) {
    return "high";
  }
  return "daredevil";
}

export function tierAbove(tradeTier, userTier) {
  if (!TIERS.includes(tradeTier) || !TIERS.includes(userTier)) {
    return false;
  }
  return TIERS.indexOf(tradeTier) > TIERS.indexOf(userTier);
}

export function evmSwapFromReceipt({ wallet, tx, receipt }) {
  const from = String(tx?.from || "").toLowerCase();
  if (!isEvmAddress(from) || from !== String(wallet || "").toLowerCase()) {
    return null;
  }
  if (receipt && receipt.status != null && receipt.status !== "0x1") {
    try {
      if (BigInt(receipt.status) !== 1n) {
        return null;
      }
    } catch {
      return null;
    }
  }
  const deltas = new Map();
  const add = (token, delta) => {
    const key = token.toLowerCase();
    deltas.set(key, (deltas.get(key) || 0n) + delta);
  };
  try {
    const value = BigInt(tx.value || "0x0");
    if (value > 0n) {
      add(NATIVE, -value);
    }
  } catch {
    return null;
  }
  for (const log of receipt?.logs || []) {
    if (String(log?.topics?.[0] || "").toLowerCase() !== TRANSFER_TOPIC || !Array.isArray(log.topics) || log.topics.length < 3) {
      continue;
    }
    const token = String(log.address || "");
    if (!isEvmAddress(token) || token.toLowerCase() === NATIVE) {
      continue;
    }
    const src = topicAddress(log.topics[1]);
    const dst = topicAddress(log.topics[2]);
    let amount;
    try {
      amount = BigInt(log.data);
    } catch {
      continue;
    }
    if (amount <= 0n) {
      continue;
    }
    if (src === from) {
      add(token, -amount);
    }
    if (dst === from) {
      add(token, amount);
    }
  }
  return twoSided(deltas, tx?.hash);
}

export function solanaSwapFromParsed(tx, owner) {
  if (!tx?.meta || tx.meta.err || !owner) {
    return null;
  }
  const deltas = new Map();
  const rows = new Map();
  const absorb = (list, sign) => {
    for (const row of list || []) {
      if (row?.owner !== owner || !row.mint || row.uiTokenAmount?.amount == null) {
        continue;
      }
      let amount;
      try {
        amount = BigInt(row.uiTokenAmount.amount);
      } catch {
        continue;
      }
      const current = rows.get(row.mint) || { mint: row.mint, delta: 0n, decimals: Number(row.uiTokenAmount.decimals) };
      current.mint = row.mint;
      current.delta += sign * amount;
      if (Number.isInteger(Number(row.uiTokenAmount.decimals))) {
        current.decimals = Number(row.uiTokenAmount.decimals);
      }
      rows.set(row.mint, current);
    }
  };
  absorb(tx.meta.preTokenBalances, -1n);
  absorb(tx.meta.postTokenBalances, 1n);
  for (const [mint, row] of rows) {
    if (row.delta !== 0n && Number.isInteger(row.decimals) && row.decimals >= 0 && row.decimals <= 18) {
      deltas.set(mint, row);
    }
  }
  const splSold = [...deltas.values()].filter((row) => row.delta < 0n);
  const splBought = [...deltas.values()].filter((row) => row.delta > 0n);
  if (splSold.length === 1 && splBought.length === 1) {
    return solLegs(splSold[0], splBought[0], tx);
  }
  const sol = solDelta(tx, owner);
  if (sol == null || (sol < 0n ? -sol : sol) <= SOL_DUST) {
    return null;
  }
  const solRow = { delta: sol, decimals: 9, mint: "SOL" };
  const sold = sol < 0n ? [solRow, ...splSold] : splSold;
  const bought = sol > 0n ? [solRow, ...splBought] : splBought;
  if (sold.length !== 1 || bought.length !== 1) {
    return null;
  }
  return solLegs(sold[0], bought[0], tx);
}

async function saveCopyWatch(chatId, raw) {
  const kind = classifyAddress(raw);
  if (!kind.valid) {
    await sendMessage(chatId, `That is not a public wallet. ${escapeHtml(kind.reason || "Unsupported address.")}`);
    return;
  }
  const chain = kind.chain === "EVM" ? "EVM" : "Solana";
  const address = chain === "EVM" ? raw.toLowerCase() : raw;
  const outcome = await mutateState((state) => {
    const chat = ensureChatState(state, chatId);
    const exists = chat.copyWatches.some((watch) => watch.chain === chain && watch.address === address);
    if (exists) {
      return { status: "exists", skipSave: true };
    }
    if (chat.copyWatches.length >= maxCopyWatches) {
      return { status: "limit", skipSave: true };
    }
    chat.copyWatches.push({
      id: randomUUID(),
      address,
      chain,
      auto: false,
      seen: [],
      solCursor: "",
      solPrimed: false,
    });
    return { status: "added" };
  });
  if (outcome.status === "exists") {
    await sendMessage(chatId, `Already watching <code>${escapeHtml(address)}</code>.`);
    return;
  }
  if (outcome.status === "limit") {
    await sendMessage(chatId, `Copy watch limit is ${maxCopyWatches}. Remove one with /uncopy &lt;address&gt;.`);
    return;
  }
  const rpcReady = chain === "EVM" ? Boolean(evmRpcUrl()) : Boolean(solanaRpcUrl());
  const envName = chain === "EVM" ? "BLARC_EVM_RPC_URL" : "BLARC_SOLANA_RPC_URL";
  await sendMessage(
    chatId,
    [
      `Watching <code>${escapeHtml(address)}</code> (${escapeHtml(chain)}).`,
      rpcReady
        ? "Watching starts from the next new trade. Older trades are not reported."
        : `Saved. Watching starts when ${envName} is set. No trades have been seen.`,
      "Auto is off. /auto on asks you to sign. /goal 40 stores a weekly percent. /risk low picks a tier.",
      chain === "Solana"
        ? "A Solana copy is only sent through the 1% fee swap you sign. If that fee cannot be included, nothing is sent."
        : "A copy is only sent through the fee-aware swap you sign.",
    ].join("\n"),
  );
}

function parseAutoArgs(watches, args) {
  let address = "";
  let mode = "";
  if (args.length === 1) {
    mode = args[0].toLowerCase();
  } else if (args.length === 2) {
    address = args[0];
    mode = args[1].toLowerCase();
  } else {
    return { error: "Usage: /auto on or /auto &lt;address&gt; off" };
  }
  if (mode !== "on" && mode !== "off") {
    return { error: "Usage: /auto on or /auto &lt;address&gt; off" };
  }
  const target = resolveWatch(watches, address);
  if (target.error) {
    return { error: target.error };
  }
  return { watch: target.watch, on: mode === "on" };
}

function resolveWatch(watches, raw) {
  if (!watches.length) {
    return { error: "You are not watching a wallet. Paste a public address or use /copy &lt;address&gt;." };
  }
  if (!raw) {
    if (watches.length === 1) {
      return { watch: watches[0] };
    }
    return { error: "You watch more than one address. Add the address: /auto &lt;address&gt; on" };
  }
  const query = raw.trim();
  const matches = watches.filter((watch) => watch.address === query || watch.address.toLowerCase() === query.toLowerCase());
  if (matches.length !== 1) {
    return { error: "That address is not in your copy watches. Use /copies." };
  }
  return { watch: matches[0] };
}

async function setRiskMax(chatId, args) {
  if (args.length === 1 && args[0].toLowerCase() === "off") {
    await mutateState((state) => {
      ensureChatState(state, chatId).riskMax = null;
    });
    await sendMessage(chatId, "Max sell size cleared. Sizing is manual. No risk-reward ratio is calculated.");
    return;
  }
  const parsed = parseDecimal(args.length === 1 ? args[0] : "");
  if (!parsed) {
    await sendMessage(chatId, "Usage: /risk max 100\nThat number is your max sell size. It is not a balance.");
    return;
  }
  const max = formatDecimal(parsed);
  await mutateState((state) => {
    ensureChatState(state, chatId).riskMax = max;
  });
  const state = await readState();
  await sendMessage(chatId, `Max sell size saved: <b>${escapeHtml(max)}</b>.\n${riskText(state.chats?.[String(chatId)])}`);
}

async function pollCopyWatches() {
  const state = await readState();
  const evm = [];
  const solana = [];
  for (const [chatId, chat] of Object.entries(state.chats || {})) {
    for (const watch of chat.copyWatches || []) {
      if (watch?.chain === "EVM" && watch.address) {
        evm.push({ chatId, watch });
      } else if (watch?.chain === "Solana" && watch.address) {
        solana.push({ chatId, watch });
      }
    }
  }
  if (evm.length > 0 && evmRpcUrl()) {
    await pollEvm(evm);
  }
  if (solana.length > 0 && solanaRpcUrl()) {
    await pollSolana(solana);
  }
}

async function pollEvm(watches) {
  const url = evmRpcUrl();
  const chainId = Number(BigInt(await rpc(url, "eth_chainId", [])));
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error("evm chain header unusable");
  }
  if (chainId !== ROBINHOOD_CHAIN_ID) {
    if (!skippedForeignEvmChain) {
      skippedForeignEvmChain = true;
      console.error("Copy watch skipped EVM blocks because the RPC chain id is not 4663. No trades were reported.");
    }
    return;
  }
  skippedForeignEvmChain = false;
  const head = BigInt(await rpc(url, "eth_blockNumber", []));
  if (head < 0n) {
    throw new Error("evm chain header unusable");
  }
  const state = await readState();
  const savedChain = state.copyCursor?.evmChainId;
  const savedNext = state.copyCursor?.evmNextBlock;
  let next = savedNext != null ? BigInt(savedNext) : null;
  if (savedChain !== chainId || next == null || head - next > MAX_EVM_GAP) {
    await mutateState((draft) => {
      draft.copyCursor ||= {};
      draft.copyCursor.evmChainId = chainId;
      draft.copyCursor.evmNextBlock = (head + 1n).toString();
    });
    if (savedChain !== chainId || next == null) {
      return;
    }
    console.error("Copy watch skipped stale EVM blocks without reporting trades.");
    return;
  }
  if (next > head) {
    return;
  }
  if (evmDecimalsChain !== chainId) {
    decimalsCache.clear();
    evmDecimalsChain = chainId;
  }
  const end = head - next + 1n > BigInt(MAX_EVM_BLOCKS) ? next + BigInt(MAX_EVM_BLOCKS) - 1n : head;
  let completed = null;
  let receipts = 0;
  let stop = false;
  for (let block = next; block <= end && !stop; block += 1n) {
    const body = await rpc(url, "eth_getBlockByNumber", [`0x${block.toString(16)}`, true]);
    const txs = Array.isArray(body?.transactions) ? body.transactions : [];
    for (const tx of txs) {
      if (!tx || typeof tx === "string" || !tx.hash) {
        continue;
      }
      const from = String(tx.from || "").toLowerCase();
      const matches = watches.filter((item) => item.watch.address.toLowerCase() === from && !(item.watch.seen || []).includes(tx.hash));
      if (matches.length === 0) {
        continue;
      }
      if (receipts >= MAX_RECEIPTS) {
        stop = true;
        break;
      }
      receipts += 1;
      const receipt = await rpc(url, "eth_getTransactionReceipt", [tx.hash]);
      const parsed = evmSwapFromReceipt({ wallet: from, tx, receipt });
      if (!parsed) {
        await markSeen(matches, tx.hash);
        continue;
      }
      let amount = null;
      try {
        const decimals = parsed.tokenIn === NATIVE ? 18 : await readDecimals(url, parsed.tokenIn);
        amount = formatUnits(BigInt(parsed.sellBase), decimals);
      } catch (error) {
        console.error("Copy watch decimals failed:", redact(error?.message));
      }
      for (const match of matches) {
        await deliverTrade(match.chatId, match.watch.address, {
          id: tx.hash,
          chain: "EVM",
          chainId,
          tokenIn: parsed.tokenIn,
          tokenOut: parsed.tokenOut,
          amount,
          hash: tx.hash,
        });
      }
    }
    if (!stop) {
      completed = block;
    }
  }
  if (completed != null) {
    await mutateState((draft) => {
      draft.copyCursor ||= {};
      draft.copyCursor.evmChainId = chainId;
      draft.copyCursor.evmNextBlock = (completed + 1n).toString();
    });
  }
}

async function pollSolana(watches) {
  const url = solanaRpcUrl();
  const groups = new Map();
  for (const item of watches) {
    const list = groups.get(item.watch.address) || [];
    list.push(item);
    groups.set(item.watch.address, list);
  }
  for (const [address, group] of groups) {
    const rows = await rpc(url, "getSignaturesForAddress", [address, { limit: 25, commitment: "confirmed" }]);
    const sigs = Array.isArray(rows) ? rows : [];
    const newest = sigs[0]?.signature || "";
    const unprimed = group.filter((item) => item.watch.solPrimed !== true);
    if (unprimed.length > 0) {
      await mutateState((draft) => {
        for (const item of unprimed) {
          const watch = findWatch(draft, item.chatId, item.watch.address, "Solana");
          if (!watch || watch.solPrimed === true) {
            continue;
          }
          watch.solPrimed = true;
          watch.solCursor = newest;
        }
      });
    }
    const live = group.filter((item) => item.watch.solPrimed === true);
    for (const item of live) {
      const cursor = item.watch.solCursor || "";
      const fresh = [];
      for (const row of sigs) {
        if (!row?.signature) {
          continue;
        }
        if (cursor && row.signature === cursor) {
          break;
        }
        fresh.push(row);
      }
      if (cursor && !sigs.some((row) => row?.signature === cursor) && sigs.length >= 25) {
        console.error("Copy watch Solana page missed the saved cursor. Older signatures were not reported.");
      }
      const ordered = fresh.reverse().slice(0, MAX_SOL_SIGS);
      let lastDone = cursor;
      for (const row of ordered) {
        if ((item.watch.seen || []).includes(row.signature)) {
          lastDone = row.signature;
          continue;
        }
        if (row.err) {
          await markSeen([item], row.signature);
          lastDone = row.signature;
          continue;
        }
        const tx = await rpc(url, "getTransaction", [row.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
        const parsed = solanaSwapFromParsed(tx, address);
        if (!parsed) {
          await markSeen([item], row.signature);
          lastDone = row.signature;
          continue;
        }
        await deliverTrade(item.chatId, address, {
          id: row.signature,
          chain: "Solana",
          chainId: null,
          tokenIn: parsed.tokenIn,
          tokenOut: parsed.tokenOut,
          amount: parsed.amount,
          hash: row.signature,
        });
        lastDone = row.signature;
      }
      if (lastDone && lastDone !== cursor) {
        await mutateState((draft) => {
          const watch = findWatch(draft, item.chatId, address, "Solana");
          if (watch) {
            watch.solCursor = lastDone;
          }
        });
      }
    }
  }
}

async function deliverTrade(chatId, address, trade) {
  const state = await readState();
  const chat = state.chats?.[String(chatId)];
  const watch = (chat?.copyWatches || []).find((item) => item.address === address && item.chain === trade.chain);
  if (!watch || (watch.seen || []).includes(trade.id)) {
    return;
  }
  const userTier = normalizeTier(chat?.riskTier);
  const tradeTier = tierFromSize(trade.amount, chat?.riskMax);
  if (trade.amount && tradeTier && userTier && tierAbove(tradeTier, userTier)) {
    await sendMessage(chatId, skipTierText(trade, tradeTier, userTier, chat.riskMax));
    await markSeen([{ chatId, watch }], trade.id);
    return;
  }
  const text = formatTradeText(trade, tradeTier, chat?.riskMax);
  if (watch.auto) {
    const reply = await performCopy(chatId, trade);
    await sendTradeNotice(chatId, trade, `${text}\n\n${reply}`);
    await markSeen([{ chatId, watch }], trade.id);
    return;
  }
  if (!trade.amount) {
    await sendTradeNotice(chatId, trade, `${text}\n\nThe sell amount could not be read, so the copy was not sent.`);
    await markSeen([{ chatId, watch }], trade.id);
    return;
  }
  const pendingId = await savePending(chatId, trade);
  await sendTradeNotice(chatId, trade, text, {
    reply_markup: {
      inline_keyboard: [[{ text: "Copy", callback_data: `cp:${pendingId}` }, { text: "Skip", callback_data: `sk:${pendingId}` }]],
    },
  });
  await markSeen([{ chatId, watch }], trade.id);
}

async function sendTradeNotice(chatId, trade, text, options) {
  const card = text.length <= 900 ? await savedCardForTrade(trade) : null;
  if (card) {
    try {
      await sendPhotoFile(chatId, card, text, { replyMarkup: options?.reply_markup });
      return;
    } catch (error) {
      console.error(`Buy notice card failed for chat ${chatId}: ${error.message}`);
    }
  }
  await sendMessage(chatId, text, options);
}

async function performCopy(chatId, trade) {
  const solana = trade.chain === "Solana";
  if (solana) {
    if (!trade.amount || !solanaTradeToken(trade.tokenIn) || !solanaTradeToken(trade.tokenOut)) {
      return "Copy not sent. The sell amount or tokens could not be read from the trade.";
    }
  } else if (!trade.amount || !isEvmAddress(trade.tokenIn) || !isEvmAddress(trade.tokenOut)) {
    return "Copy not sent. The sell amount or tokens could not be read from the trade.";
  }
  const state = await readState();
  const chat = state.chats?.[String(chatId)];
  const wallet = sanitizeWallet(chat?.wallet);
  if (!wallet) {
    return "No wallet is connected, so this copy was not sent.";
  }
  const userChain = chainIdNumber(wallet.chainId);
  if (solana) {
    if (wallet.chainId !== SOLANA_SENTINEL_CHAIN_ID) {
      return `Copy not sent. This trade is on Solana and your wallet is on chain ${userChain == null ? "unknown" : userChain}.`;
    }
  } else if (userChain == null || userChain !== trade.chainId) {
    return `Copy not sent. This trade is on chain ${trade.chainId} and your wallet is on chain ${userChain == null ? "unknown" : userChain}.`;
  }
  const userTier = normalizeTier(chat?.riskTier);
  const tradeTier = tierFromSize(trade.amount, chat?.riskMax);
  if (tradeTier && userTier && tierAbove(tradeTier, userTier)) {
    return oneLine(skipTierText(trade, tradeTier, userTier, chat.riskMax));
  }
  try {
    const reply = await executeSwap({
      chatId,
      wallet,
      amount: trade.amount,
      tokenIn: trade.tokenIn,
      tokenOut: trade.tokenOut,
    });
    return solana ? solanaCopyReply(reply) : reply;
  } catch (error) {
    console.error("Copy swap failed:", redact(error?.message));
    return "Copy not sent. The fee-aware swap could not be requested.";
  }
}

function solanaTradeToken(token) {
  const value = String(token || "");
  return value === "SOL" || isSolanaAddress(value);
}

function solanaCopyReply(reply) {
  const text = String(reply || "").trim();
  const feePrefix = "Fee cannot be included, swap not sent.";
  if (!text) {
    return "Copy not sent. The fee-aware swap could not be requested.";
  }
  if (text.startsWith(feePrefix)) {
    const detail = text.slice(feePrefix.length).trim();
    return detail
      ? `Copy not sent because the fee could not be included. ${detail}`
      : "Copy not sent because the fee could not be included.";
  }
  if (text.startsWith("Swap not sent.")) {
    return `Copy not sent. ${text.slice("Swap not sent.".length).trim()}`;
  }
  if (text.startsWith("Swap refused.")) {
    return `Copy not sent. ${text.slice("Swap refused.".length).trim()}`;
  }
  return text;
}

function formatTradeText(trade, tradeTier, max) {
  const lines = [
    "<b>Watched wallet traded</b>",
    `Chain: <b>${escapeHtml(trade.chain)}${trade.chainId ? ` ${trade.chainId}` : ""}</b>`,
    `Sold: <b>${escapeHtml(trade.amount || "unreadable amount")}</b> <code>${escapeHtml(shortToken(trade.tokenIn))}</code>`,
    `Bought: <code>${escapeHtml(shortToken(trade.tokenOut))}</code>`,
  ];
  if (tradeTier && max) {
    lines.push(`Size: <b>${TIER_LABEL[tradeTier]}</b> (sell ${escapeHtml(trade.amount)} vs max ${escapeHtml(String(max))}).`);
  } else {
    lines.push("Sizing is manual.");
  }
  if (trade.hash) {
    lines.push(`Tx: <code>${escapeHtml(trade.hash)}</code>`);
  }
  const link = tradeLink(trade);
  if (link) {
    lines.push(escapeHtml(link));
  }
  lines.push("BLARC does not sign.");
  return lines.join("\n");
}

function skipTierText(trade, tradeTier, userTier, max) {
  return `Skipped. Sell ${trade.amount} vs max ${max} is ${TIER_LABEL[tradeTier]}, above your ${TIER_LABEL[userTier]} tier, so the copy was not sent.`;
}

function goalText(percent) {
  if (typeof percent !== "number") {
    return "Weekly goal: <b>not set</b>. /goal 40 stores a percent. Profit tracking is not live yet.";
  }
  return `Weekly goal: <b>${escapeHtml(String(percent))}%</b> of the account. Profit tracking is not live yet.`;
}

function riskText(chat) {
  const tier = normalizeTier(chat?.riskTier);
  const max = chat?.riskMax;
  if (!tier && !max) {
    return "Risk: <b>not set</b>. /risk low, average, high, or daredevil. Sizing is manual. No risk-reward ratio is calculated.";
  }
  const tierLine = tier ? `Risk: <b>${TIER_LABEL[tier]}</b>.` : "Risk tier: <b>not set</b>.";
  if (!max) {
    return `${tierLine} Sizing is manual until /risk max &lt;amount&gt;. No risk-reward ratio is calculated.`;
  }
  return `${tierLine} Max sell size: <b>${escapeHtml(String(max))}</b>. A trade is labeled only from sell size vs that max. Above your tier is skipped.`;
}

function tradeLink(trade) {
  if (trade.chain === "Solana" && trade.hash) {
    return `https://solscan.io/tx/${trade.hash}`;
  }
  const bases = {
    1: "https://etherscan.io/tx/",
    10: "https://optimistic.etherscan.io/tx/",
    56: "https://bscscan.com/tx/",
    137: "https://polygonscan.com/tx/",
    8453: "https://basescan.org/tx/",
    42161: "https://arbiscan.io/tx/",
    43114: "https://snowtrace.io/tx/",
    4663: "https://robinhoodchain.blockscout.com/tx/",
    5042: "https://explorer.arc.io/tx/",
  };
  return bases[trade.chainId] && trade.hash ? `${bases[trade.chainId]}${trade.hash}` : "";
}

function shortToken(token) {
  const value = String(token || "");
  if (value === NATIVE) {
    return "native";
  }
  if (value.length <= 18) {
    return value;
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function twoSided(deltas, hash) {
  const legs = [...deltas.entries()].filter(([, delta]) => delta !== 0n);
  const sold = legs.filter(([, delta]) => delta < 0n);
  const bought = legs.filter(([, delta]) => delta > 0n);
  if (sold.length !== 1 || bought.length !== 1) {
    return null;
  }
  if (!/^0x[a-fA-F0-9]{64}$/.test(String(hash || ""))) {
    return null;
  }
  return {
    tokenIn: sold[0][0],
    tokenOut: bought[0][0],
    sellBase: (-sold[0][1]).toString(),
    buyBase: bought[0][1].toString(),
    hash,
  };
}

function solLegs(sold, bought, tx) {
  const signature = tx?.transaction?.signatures?.[0];
  if (!signature || !sold || !bought) {
    return null;
  }
  const amount = formatUnits(-sold.delta, sold.decimals);
  if (!amount || amount === "0") {
    return null;
  }
  return {
    tokenIn: sold.mint,
    tokenOut: bought.mint,
    amount,
    hash: signature,
  };
}

function solDelta(tx, owner) {
  const keys = accountKeys(tx);
  const index = keys.indexOf(owner);
  const pre = tx.meta?.preBalances?.[index];
  const post = tx.meta?.postBalances?.[index];
  if (index < 0 || pre == null || post == null || keys.length !== tx.meta.preBalances.length) {
    return null;
  }
  try {
    let delta = BigInt(post) - BigInt(pre);
    if (index === 0 && tx.meta.fee != null) {
      delta += BigInt(tx.meta.fee);
    }
    return delta;
  } catch {
    return null;
  }
}

function accountKeys(tx) {
  const raw = tx.transaction?.message?.accountKeys || [];
  const keys = raw.map((key) => (typeof key === "string" ? key : key?.pubkey)).filter(Boolean);
  const loaded = tx.meta?.loadedAddresses || {};
  return keys.concat(loaded.writable || [], loaded.readonly || []);
}

async function savePending(chatId, trade) {
  const id = randomBytes(8).toString("hex");
  await mutateState((state) => {
    const chat = ensureChatState(state, chatId);
    const now = Date.now();
    chat.pendingCopies = (chat.pendingCopies || []).filter((pending) => now - pending.createdAt < PENDING_MS).slice(-19);
    chat.pendingCopies.push({
      id,
      chatId: String(chatId),
      chain: trade.chain,
      chainId: trade.chainId,
      tokenIn: trade.tokenIn,
      tokenOut: trade.tokenOut,
      amount: trade.amount,
      hash: trade.hash,
      createdAt: now,
    });
  });
  return id;
}

async function takePending(chatId, id) {
  return mutateState((state) => {
    const chat = ensureChatState(state, chatId);
    const now = Date.now();
    const before = (chat.pendingCopies || []).length;
    chat.pendingCopies = (chat.pendingCopies || []).filter((pending) => now - pending.createdAt < PENDING_MS);
    const index = chat.pendingCopies.findIndex((pending) => pending.id === id && String(pending.chatId) === String(chatId));
    if (index < 0) {
      return { pending: null, reason: "That choice is closed. Nothing was sent.", skipSave: before === chat.pendingCopies.length };
    }
    const [pending] = chat.pendingCopies.splice(index, 1);
    return { pending };
  });
}

async function markSeen(matches, hash) {
  if (!hash) {
    return;
  }
  await mutateState((state) => {
    let changed = false;
    for (const item of matches) {
      const watch = findWatch(state, item.chatId, item.watch.address, item.watch.chain);
      if (!watch) {
        continue;
      }
      watch.seen ||= [];
      if (!watch.seen.includes(hash)) {
        watch.seen.push(hash);
        watch.seen = watch.seen.slice(-40);
        changed = true;
      }
    }
    if (!changed) {
      return { skipSave: true };
    }
    return {};
  });
}

function findWatch(state, chatId, address, chain) {
  return ensureChatState(state, chatId).copyWatches.find((watch) => watch.address === address && watch.chain === chain);
}

async function readDecimals(url, token) {
  const key = `${evmDecimalsChain}:${token.toLowerCase()}`;
  if (decimalsCache.has(key)) {
    return decimalsCache.get(key);
  }
  const result = await rpc(url, "eth_call", [{ to: token, data: "0x313ce567" }, "latest"]);
  if (!/^0x[0-9a-fA-F]+$/.test(String(result || ""))) {
    throw new Error("decimals unreadable");
  }
  const decimals = Number(BigInt(result));
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error("decimals out of range");
  }
  decimalsCache.set(key, decimals);
  return decimals;
}

async function rpc(url, method, params) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "blarc-bot" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw new Error(`${method} unreachable`);
  }
  if (!response.ok) {
    throw new Error(`${method} http ${response.status}`);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${method} bad json`);
  }
  if (!body || body.error || body.result === undefined) {
    throw new Error(`${method} rejected`);
  }
  return body.result;
}

function topicAddress(topic) {
  const hex = String(topic || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hex)) {
    return "";
  }
  return `0x${hex.slice(-40)}`;
}

function parseDecimal(raw) {
  const text = String(raw || "").trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    return null;
  }
  const [whole, frac = ""] = text.split(".");
  if (whole.length + frac.length > 40) {
    return null;
  }
  const value = BigInt(whole) * 10n ** BigInt(frac.length) + BigInt(frac || "0");
  if (value <= 0n) {
    return null;
  }
  return { value, scale: frac.length };
}

function formatDecimal(parsed) {
  return formatUnits(parsed.value, parsed.scale);
}

function formatUnits(value, decimals) {
  const scale = 10n ** BigInt(decimals);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(Number(decimals), "0").replace(/0+$/, "");
  const text = frac ? `${whole}.${frac}` : whole.toString();
  return negative ? `-${text}` : text;
}

function secretRejection() {
  return "That looks like a seed phrase or private key. BLARC does not accept it. Paste a public wallet address only. Nothing was saved.";
}

function oneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function redact(message) {
  return String(message || "copy watch failed").replace(/https?:\/\/\S+/gi, "[url]").slice(0, 180);
}

async function answerCallback(id, text) {
  if (!id) {
    return;
  }
  try {
    await telegram("answerCallbackQuery", {
      callback_query_id: id,
      text: String(text || "").slice(0, 180),
    });
  } catch (error) {
    console.error("Copy callback answer failed:", redact(error?.message));
  }
}

async function clearButtons(chatId, messageId) {
  if (!chatId || !messageId) {
    return;
  }
  try {
    await telegram("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
  } catch (error) {
    console.error("Copy button clear failed:", redact(error?.message));
  }
}
