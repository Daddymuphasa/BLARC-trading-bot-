import { randomBytes } from "node:crypto";
import { createWallet, sanitizeCreatedWallet } from "./createWallet.js";
import { ensureChatState, mutateState } from "./state.js";
import { escapeHtml, sendMessage, telegram } from "./telegram.js";

const CONFIRM_MS = 10 * 60 * 1000;
const pendingById = new Map();
const pendingByChat = new Map();

export async function handleCreate(message) {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  if (!userId) {
    await sendMessage(chatId, "Could not tell who sent /create, so no wallet was created and nothing was saved.");
    return;
  }

  let created;
  try {
    created = createWallet();
  } catch {
    console.error("Wallet create failed");
    await sendMessage(chatId, "Could not create a wallet. Nothing was saved.");
    return;
  }

  const id = armPending(chatId, userId, created);
  created = undefined;

  try {
    await sendMessage(
      chatId,
      [
        "<b>Stop. Read this before any seed is shown.</b>",
        "",
        "This is the only time this seed will ever be shown. Telegram keeps this chat history. Write it down offline, on paper.",
        "",
        "BLARC will never show this seed again and never stores it. The bot cannot trade this wallet, because it does not keep the key. That is intentional.",
        "",
        "Tap <b>Show my seed once</b> to reveal it. If you do not tap, no seed is sent and nothing is saved.",
        "The button expires in 10 minutes. /create again makes a different wallet, not a replay of this one.",
        "",
        "After you write it down, import it into your own wallet and use /connect to sign. Then delete the seed message yourself. BLARC cannot erase Telegram chat history.",
      ].join("\n"),
      {
        reply_markup: {
          inline_keyboard: [[{ text: "Show my seed once", callback_data: `cs:${id}` }]],
        },
      },
    );
  } catch {
    dropPending(id);
    console.error("Wallet create warning failed");
    await sendMessage(chatId, "The warning could not be sent, so the seed was discarded. Nothing was saved.");
  }
}

export async function handleCreateCallback(callback) {
  const data = String(callback?.data || "");
  if (!data.startsWith("cs:")) {
    return false;
  }

  const chatId = callback?.message?.chat?.id;
  const id = data.slice(3);
  const entry = pendingById.get(id);
  if (!entry || !chatId || String(chatId) !== entry.chatId) {
    await answerCreate(callback?.id, "That seed is not waiting to be shown. If you already confirmed, it will not be repeated.");
    return true;
  }
  if (Date.now() - entry.createdAt > CONFIRM_MS) {
    dropPending(id);
    await answerCreate(callback?.id, "That confirmation expired. The seed was discarded and was not stored.");
    return true;
  }
  if (String(callback?.from?.id || "") !== entry.userId) {
    await answerCreate(callback?.id, "Only the person who ran /create can reveal this seed.");
    return true;
  }
  if (entry.sending || entry.shown) {
    await answerCreate(callback?.id, "This seed was already shown once. It will not be repeated.");
    return true;
  }

  entry.sending = true;
  let mnemonic = entry.mnemonic;
  const evm = entry.evm;
  const solana = entry.solana;
  let delivered = false;
  try {
    await sendMessage(chatId, seedMessage(mnemonic, evm, solana));
    delivered = true;
  } catch {
    entry.sending = false;
    console.error("Wallet seed delivery failed");
    await answerCreate(callback?.id, "The seed could not be sent. Nothing was saved. Tap again to retry.");
    return true;
  } finally {
    mnemonic = undefined;
  }
  if (!delivered) {
    return true;
  }

  entry.shown = true;
  entry.mnemonic = undefined;
  dropPending(id);
  await clearCreateButton(chatId, callback?.message?.message_id);
  await answerCreate(callback?.id, "Shown once. It will not be repeated.");

  try {
    await mutateState((state) => {
      const chat = ensureChatState(state, chatId);
      chat.createdWallet = sanitizeCreatedWallet({ evm, solana });
    });
  } catch {
    console.error("Wallet create address save failed");
    await sendMessage(
      chatId,
      [
        "The seed was shown above and will not be repeated. The public addresses could not be saved. Nothing secret was stored.",
        addressLines(evm, solana),
      ].join("\n"),
    );
    return true;
  }

  try {
    await sendMessage(
      chatId,
      [
        "<b>Reveal window closed</b>",
        "This seed will not be shown again. BLARC did not erase the message above and cannot delete Telegram history. Delete that message yourself after you have written the seed down.",
        "",
        "Only the public addresses were saved for this chat. Trading still needs /connect so you can sign in your own wallet.",
        addressLines(evm, solana),
      ].join("\n"),
    );
  } catch {
    console.error("Wallet create follow-up failed");
  }
  return true;
}

export function formatCreatedWallet(chat) {
  const created = sanitizeCreatedWallet(chat?.createdWallet);
  if (!created) {
    return "Created wallet: <b>none</b> (/create)";
  }
  return ["Created wallet (public only):", addressLines(created.evm, created.solana)].join("\n");
}

function seedMessage(mnemonic, evm, solana) {
  return [
    "<b>Seed shown once</b>",
    `<code>${escapeHtml(mnemonic)}</code>`,
    "",
    addressLines(evm, solana),
    "",
    "Write this down offline now. Import it into your own wallet, then use /connect to sign. BLARC does not keep this key and cannot trade this wallet.",
  ].join("\n");
}

function addressLines(evm, solana) {
  const lines = [];
  if (evm) {
    lines.push(`EVM (m/44'/60'/0'/0/0): <code>${escapeHtml(evm)}</code>`);
  }
  if (solana) {
    lines.push(`Solana (m/44'/501'/0'/0'): <code>${escapeHtml(solana)}</code>`);
  }
  return lines.join("\n");
}

function armPending(chatId, userId, created) {
  const key = String(chatId);
  const previous = pendingByChat.get(key);
  if (previous) {
    dropPending(previous);
  }
  const id = randomBytes(8).toString("hex");
  const entry = {
    id,
    chatId: key,
    userId: String(userId),
    mnemonic: created.mnemonic,
    evm: created.evm,
    solana: created.solana || null,
    createdAt: Date.now(),
    sending: false,
    shown: false,
    timer: null,
  };
  entry.timer = setTimeout(() => dropPending(id), CONFIRM_MS);
  entry.timer.unref?.();
  pendingById.set(id, entry);
  pendingByChat.set(key, id);
  return id;
}

function dropPending(id) {
  const entry = pendingById.get(id);
  if (!entry) {
    return;
  }
  pendingById.delete(id);
  if (pendingByChat.get(entry.chatId) === id) {
    pendingByChat.delete(entry.chatId);
  }
  if (entry.timer) {
    clearTimeout(entry.timer);
  }
  entry.mnemonic = undefined;
}

async function clearCreateButton(chatId, messageId) {
  if (!chatId || !messageId) {
    return;
  }
  try {
    await telegram("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
  } catch {
    console.error("Create button clear failed");
  }
}

async function answerCreate(id, text) {
  if (!id) {
    return;
  }
  try {
    await telegram("answerCallbackQuery", {
      callback_query_id: id,
      text: String(text || "").slice(0, 180),
    });
  } catch {
    console.error("Create callback answer failed");
  }
}
