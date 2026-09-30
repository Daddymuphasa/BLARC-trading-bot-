import { randomUUID } from "node:crypto";
import { classifyAddress, findTrackedPair, formatUsd } from "./dexscreener.js";
import { maxPriceWatches, priceCheckGapMs, priceCheckIntervalMs } from "./config.js";
import { ensureChatState, mutateState, readState } from "./state.js";
import { ensurePairCard, savedCardPath } from "./cards.js";
import { escapeHtml, sendMessage, sendPhotoFile, sleep } from "./telegram.js";

export async function handleWatch(message, args) {
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

  if (pair && classifyAddress(parsed.query).valid) {
    await ensurePairCard(pair);
  }

  await sendMessage(message.chat.id, formatWatchConfirmation(outcome.watch, outcome.status, outcome.alerts));
}

export async function handleWatchlist(message) {
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

export async function handleUnwatch(message, args) {
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

export function startPriceAlertLoop() {
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
      await deliverPriceAlert(event);
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

async function deliverPriceAlert(event) {
  const card = await savedCardPath(event.watch?.chainId, event.watch?.tokenAddress);
  if (card) {
    try {
      await sendPhotoFile(event.chatId, card, shortPriceCaption(event));
      return;
    } catch (error) {
      console.error(`Price alert card failed for chat ${event.chatId}: ${error.message}`);
    }
  }
  await sendMessage(event.chatId, formatPriceAlert(event));
}

function shortPriceCaption(event) {
  const watch = event.watch;
  const label = watch.symbol || watch.query;
  const direction = event.direction === "above" ? "above" : "below";
  return [
    `<b>${escapeHtml(label)}</b> crossed ${direction} ${formatUsd(event.target)}`,
    `Now ${formatUsd(event.price)}`,
    "Fired once. /watch rearm",
  ].join("\n");
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

export async function handleAlerts(message, args) {
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
