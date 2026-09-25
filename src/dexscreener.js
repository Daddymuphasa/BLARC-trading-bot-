const baseUrl = "https://api.dexscreener.com";
const requestTimeoutMs = 9000;

export async function findBestPair(query) {
  const normalized = String(query || "").trim();
  if (!normalized) {
    return null;
  }

  const addressInfo = classifyAddress(normalized);
  const pairs = addressInfo.valid ? await findPairsByAddress(normalized, addressInfo) : await searchPairs(normalized);
  return selectBestPair(pairs);
}

export async function searchPairs(query) {
  const url = `${baseUrl}/latest/dex/search?q=${encodeURIComponent(query)}`;
  const data = await requestJson(url);
  return Array.isArray(data?.pairs) ? data.pairs : [];
}

export function classifyAddress(value) {
  if (/^0x[a-fA-F0-9]{40}$/.test(value)) {
    return {
      valid: true,
      chain: "EVM",
      chainIds: ["ethereum", "bsc", "base", "arbitrum", "polygon", "avalanche"],
    };
  }

  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) {
    return {
      valid: true,
      chain: "Solana/Base58",
      chainIds: ["solana"],
    };
  }

  return { valid: false, reason: "expected EVM 0x address or Solana-style base58 address", chainIds: [] };
}

export function formatPairSummary(pair) {
  const base = pair?.baseToken?.symbol || "UNKNOWN";
  const quote = pair?.quoteToken?.symbol || "?";
  const name = pair?.baseToken?.name || base;
  const lines = [
    `<b>${escapeHtml(name)} (${escapeHtml(base)}/${escapeHtml(quote)})</b>`,
    `Chain: <b>${escapeHtml(pair?.chainId || "unknown")}</b>`,
    `DEX: <b>${escapeHtml(pair?.dexId || "unknown")}</b>`,
    `Price: <b>${formatUsd(pair?.priceUsd)}</b>`,
    `Liquidity: <b>${formatUsd(pair?.liquidity?.usd)}</b>`,
    `24h Volume: <b>${formatUsd(pair?.volume?.h24)}</b>`,
    `24h Change: <b>${formatPercent(pair?.priceChange?.h24)}</b>`,
    `Market Cap: <b>${formatUsd(pair?.marketCap || pair?.fdv)}</b>`,
  ];

  if (pair?.pairCreatedAt) {
    lines.push(`Pair Age: <b>${formatAge(pair.pairCreatedAt)}</b>`);
  }

  if (pair?.url) {
    lines.push(`Chart: ${escapeHtml(pair.url)}`);
  }

  return lines;
}

export function buildMarketRiskLines(pair) {
  if (!pair) {
    return {
      lines: ["⚠️ Market data: no DexScreener pair found"],
      score: 0,
    };
  }

  const lines = [];
  let score = 0;
  const liquidity = Number(pair?.liquidity?.usd || 0);
  const volume = Number(pair?.volume?.h24 || 0);
  const createdAt = Number(pair?.pairCreatedAt || 0);
  const ageHours = createdAt > 0 ? (Date.now() - createdAt) / 3600000 : null;

  if (liquidity >= 100000) {
    lines.push(`✅ Liquidity: ${formatUsd(liquidity)}`);
    score += 2;
  } else if (liquidity >= 10000) {
    lines.push(`⚠️ Liquidity: ${formatUsd(liquidity)}`);
    score += 1;
  } else {
    lines.push(`🚩 Liquidity: ${formatUsd(liquidity)}`);
  }

  if (volume >= 50000) {
    lines.push(`✅ 24h Volume: ${formatUsd(volume)}`);
    score += 2;
  } else if (volume >= 5000) {
    lines.push(`⚠️ 24h Volume: ${formatUsd(volume)}`);
    score += 1;
  } else {
    lines.push(`🚩 24h Volume: ${formatUsd(volume)}`);
  }

  if (ageHours === null) {
    lines.push("⚠️ Pair age: unavailable");
  } else if (ageHours >= 24) {
    lines.push(`✅ Pair age: ${formatAge(createdAt)}`);
    score += 1;
  } else {
    lines.push(`⚠️ Pair age: ${formatAge(createdAt)}`);
  }

  lines.push(`Chart: ${escapeHtml(pair.url || "unavailable")}`);
  return { lines, score };
}

async function findPairsByAddress(address, addressInfo) {
  const chainIds = addressInfo.chainIds.length > 0 ? addressInfo.chainIds : ["solana", "ethereum", "bsc", "base", "arbitrum"];
  const results = [];

  for (const chainId of chainIds) {
    try {
      const pairs = await getTokenPairs(chainId, address);
      results.push(...pairs);
    } catch {
      // Unsupported chain/address combinations can fail; continue to the next likely chain.
    }
  }

  if (results.length > 0) {
    return results;
  }

  return searchPairs(address);
}

async function getTokenPairs(chainId, tokenAddress) {
  const url = `${baseUrl}/token-pairs/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(tokenAddress)}`;
  const data = await requestJson(url);
  return Array.isArray(data) ? data : [];
}

function selectBestPair(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) {
    return null;
  }

  return pairs
    .filter(Boolean)
    .sort((a, b) => pairScore(b) - pairScore(a))[0];
}

function pairScore(pair) {
  const liquidity = Number(pair?.liquidity?.usd || 0);
  const volume = Number(pair?.volume?.h24 || 0);
  const txns = Number(pair?.txns?.h24?.buys || 0) + Number(pair?.txns?.h24?.sells || 0);
  return liquidity * 3 + volume + txns * 25;
}

async function requestJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`DexScreener returned HTTP ${response.status}`);
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export function formatUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return "n/a";
  }

  if (number < 0.01) {
    return `$${number.toPrecision(3)}`;
  }

  return new Intl.NumberFormat("en-US", {
    compactDisplay: "short",
    currency: "USD",
    maximumFractionDigits: number >= 1 ? 2 : 6,
    notation: number >= 100000 ? "compact" : "standard",
    style: "currency",
  }).format(number);
}

function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "n/a";
  }

  return `${number > 0 ? "+" : ""}${number.toFixed(2)}%`;
}

function formatAge(timestampMs) {
  const ageMs = Date.now() - Number(timestampMs);
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return "n/a";
  }

  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }

  return `${Math.floor(hours / 24)}d`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
