import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { statePath } from "./config.js";
import { sanitizeCreatedWallet } from "./createWallet.js";
import { sanitizeWallet } from "./wallet.js";

let stateLock = Promise.resolve();

export async function upsertChat(chatId, defaults = {}) {
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

export async function readState() {
  return withStateLock(() => loadState());
}

export async function mutateState(mutator) {
  return withStateLock(async () => {
    const state = await loadState();
    const result = await mutator(state);
    if (!result?.skipSave) {
      await saveState(state);
    }
    return result;
  });
}

export function ensureChatState(state, chatId) {
  const key = String(chatId);
  state.chats[key] ||= {
    alerts: true,
    watchlist: [],
    priceWatches: [],
  };

  state.chats[key].watchlist ||= [];
  state.chats[key].priceWatches ||= [];
  state.chats[key].alerts = state.chats[key].alerts !== false;
  scrubChatSecrets(state.chats[key]);
  normalizeCopyFields(state.chats[key]);
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


const COPY_TIERS = new Set(["low", "average", "high", "daredevil"]);

function normalizeCopyFields(chat) {
  const watches = Array.isArray(chat.copyWatches) ? chat.copyWatches : [];
  chat.copyWatches = watches.filter((watch) => watch && typeof watch.address === "string" && (watch.chain === "EVM" || watch.chain === "Solana")).map((watch) => {
    if (!watch.id) {
      watch.id = randomUUID();
    }
    watch.auto = watch.auto === true;
    watch.seen = Array.isArray(watch.seen) ? watch.seen.filter((item) => typeof item === "string").slice(-40) : [];
    watch.solCursor = typeof watch.solCursor === "string" ? watch.solCursor : "";
    watch.solPrimed = watch.solPrimed === true;
    return watch;
  });
  const pending = Array.isArray(chat.pendingCopies) ? chat.pendingCopies : [];
  chat.pendingCopies = pending.filter((item) => item && typeof item.id === "string" && typeof item.createdAt === "number").slice(-20);
  if (typeof chat.weeklyGoalPercent !== "number" || !Number.isFinite(chat.weeklyGoalPercent) || chat.weeklyGoalPercent <= 0) {
    chat.weeklyGoalPercent = null;
  }
  if (!COPY_TIERS.has(chat.riskTier)) {
    chat.riskTier = null;
  }
  if (typeof chat.riskMax !== "string" || !/^\d+(\.\d+)?$/.test(chat.riskMax)) {
    chat.riskMax = null;
  }
}

export async function ensureState() {
  await mkdir(path.dirname(statePath), { recursive: true });
  try {
    await readFile(statePath, "utf8");
  } catch {
    await saveState({ chats: {} });
  }
}

export async function loadState() {
  await ensureState();
  const raw = await readFile(statePath, "utf8");
  const state = JSON.parse(raw);
  scrubState(state);
  return state;
}

const SECRET_CHAT_KEYS = ["mnemonic", "seedPhrase", "seed", "privateKey", "private_key", "xprv", "secretKey"];

function scrubChatSecrets(chat) {
  if (!chat || typeof chat !== "object") {
    return;
  }
  if (chat.createdWallet !== undefined) {
    chat.createdWallet = sanitizeCreatedWallet(chat.createdWallet);
  }
  for (const key of SECRET_CHAT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(chat, key)) {
      delete chat[key];
    }
  }
}

function scrubState(state) {
  if (!state?.chats || typeof state.chats !== "object") {
    return;
  }
  for (const chat of Object.values(state.chats)) {
    scrubChatSecrets(chat);
  }
}

export async function saveState(state) {
  scrubState(state);
  await mkdir(path.dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tmpPath, statePath);
}
