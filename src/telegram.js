import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { token } from "./config.js";

const guidesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "guides");

export async function telegram(method, payload) {
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

export async function sendMessage(chatId, text, options = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...options,
  });
}

export async function sendPlain(chatId, text) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
}

export async function editMessageText(chatId, messageId, text, options = {}) {
  return telegram("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...options,
  });
}

export async function answerCallbackQuery(callbackQueryId, text = "") {
  if (!callbackQueryId) {
    return null;
  }
  try {
    return await telegram("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: String(text || "").slice(0, 180),
    });
  } catch (error) {
    console.error("answerCallbackQuery failed:", error.message);
    return null;
  }
}

export async function sendPhoto(chatId, png, caption, options = {}) {
  return postPhoto(chatId, new Blob([png], { type: "image/png" }), "blarc-connect.png", caption, options);
}

export async function sendPhotoFile(chatId, filePath, caption, options = {}) {
  const bytes = await readFile(filePath);
  const name = path.basename(filePath);
  const type = filePath.endsWith(".png") ? "image/png" : "image/jpeg";
  return postPhoto(chatId, new Blob([bytes], { type }), name, caption, { parseMode: "HTML", ...options });
}

export async function sendGuide(chatId, fileName, caption) {
  if (!/^(welcome|help|trade|copy)\.jpg$/.test(fileName)) {
    throw new Error("Unknown guide image");
  }
  try {
    return await sendPhotoFile(chatId, path.join(guidesDir, fileName), caption);
  } catch (error) {
    console.error(`Guide photo failed (${fileName}):`, error.message);
    return null;
  }
}

async function postPhoto(chatId, blob, filename, caption, options = {}) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) {
    form.append("caption", caption);
  }
  if (options.parseMode) {
    form.append("parse_mode", options.parseMode);
  }
  if (options.replyMarkup) {
    form.append("reply_markup", JSON.stringify(options.replyMarkup));
  }
  form.append("photo", blob, filename);
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

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function inlineKeyboard(rows) {
  return { inline_keyboard: rows };
}

export function urlBtn(text, url) {
  return { text, url };
}

export function copyBtn(text, value) {
  return { text, copy_text: { text: String(value) } };
}

export function btn(text, data) {
  return { text, callback_data: String(data).slice(0, 64) };
}
