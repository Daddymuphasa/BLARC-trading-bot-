import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { statePath } from "./config.js";
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
  return JSON.parse(raw);
}

export async function saveState(state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tmpPath, statePath);
}
