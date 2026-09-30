import { mkdir, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { formatUsd } from "./dexscreener.js";

const WIDTH = 1080;
const HEIGHT = 1350;
const cardsDir = path.join(process.cwd(), "data", "cards");
const mascotPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "blarc-mascot.jpg");
const inflight = new Map();

const chainAmms = {
  solana: ["solamm"],
  ethereum: ["uniswap"],
  bsc: ["uniswap"],
  base: ["uniswap"],
  arbitrum: ["uniswap"],
  polygon: ["uniswap"],
  optimism: ["uniswap"],
  avalanche: ["uniswap"],
};

const evmDexChain = {
  1: "ethereum",
  10: "optimism",
  56: "bsc",
  137: "polygon",
  8453: "base",
  42161: "arbitrum",
  43114: "avalanche",
  4663: "robinhood",
  5042: "arc",
};

export async function ensurePairCard(pair) {
  const filePath = cardFilePath(pair?.chainId, pair?.baseToken?.address);
  if (!filePath) {
    return null;
  }
  if (await fileExists(filePath)) {
    return filePath;
  }
  if (inflight.has(filePath)) {
    return inflight.get(filePath);
  }
  const job = buildPairCard(pair, filePath).finally(() => {
    inflight.delete(filePath);
  });
  inflight.set(filePath, job);
  return job;
}

export async function savedCardPath(chainId, tokenAddress) {
  const filePath = cardFilePath(chainId, tokenAddress);
  if (!filePath || !(await fileExists(filePath))) {
    return null;
  }
  return filePath;
}

export async function savedCardForTrade(trade) {
  const token = String(trade?.tokenOut || "");
  if (!token || token === "SOL" || token.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") {
    return null;
  }
  if (trade?.chain === "Solana") {
    return savedCardPath("solana", token);
  }
  if (trade?.chain === "EVM") {
    const slug = evmDexChain[Number(trade.chainId)];
    return slug ? savedCardPath(slug, token) : null;
  }
  return null;
}

function cardFilePath(chainId, tokenAddress) {
  const name = cardFileName(chainId, tokenAddress);
  return name ? path.join(cardsDir, name) : null;
}

function cardFileName(chainId, tokenAddress) {
  const chain = String(chainId || "").trim().toLowerCase();
  let token = String(tokenAddress || "").trim();
  if (!/^[a-z0-9-]{1,32}$/.test(chain)) {
    return null;
  }
  if (/^0x[a-fA-F0-9]{40}$/.test(token)) {
    token = token.toLowerCase();
  } else if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token)) {
    return null;
  }
  return `${chain}-${token}.jpg`;
}

async function fileExists(filePath) {
  try {
    const bytes = await readFile(filePath);
    return bytes.length > 0;
  } catch {
    return false;
  }
}

async function buildPairCard(pair, filePath) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    await mkdir(cardsDir, { recursive: true });
    const closes = await fetchCloses(pair);
    const svg = renderCardSvg(pair, closes);
    const layers = [];
    const logo = await loadLogo(pair);
    if (logo) {
      try {
        layers.push({ input: await roundedImage(logo, 168, 84), left: 56, top: 56 });
      } catch (error) {
        console.error("Pair card logo skipped:", error.message);
      }
    }
    try {
      const mascot = await readFile(mascotPath);
      layers.push({ input: await roundedImage(mascot, 168, 28), left: 856, top: 48 });
    } catch (error) {
      console.error("Pair card mascot skipped:", error.message);
    }
    await sharp(Buffer.from(svg)).resize(WIDTH, HEIGHT).composite(layers).jpeg({ quality: 86 }).toFile(tmp);
    await rename(tmp, filePath);
    return filePath;
  } catch (error) {
    console.error("Pair card failed:", error.message);
    await unlink(tmp).catch(() => {});
    return null;
  }
}

async function fetchCloses(pair) {
  const chainId = String(pair?.chainId || "").trim().toLowerCase();
  const pairAddress = String(pair?.pairAddress || "").trim();
  const quote = String(pair?.quoteToken?.address || "").trim();
  const dexId = String(pair?.dexId || "").trim().toLowerCase();
  if (!chainId || !pairAddress || !quote) {
    return null;
  }
  const amms = [];
  for (const amm of [...(chainAmms[chainId] || []), dexId]) {
    if (amm && !amms.includes(amm)) {
      amms.push(amm);
    }
  }
  for (const amm of amms) {
    const url = `https://io.dexscreener.com/dex/chart/amm/v3/${encodeURIComponent(amm)}/bars/${encodeURIComponent(chainId)}/${encodeURIComponent(pairAddress)}?res=15&cb=48&q=${encodeURIComponent(quote)}&uo=0`;
    const bytes = await fetchBytes(url, 1_500_000);
    const closes = bytes ? closesFromDexBars(bytes) : null;
    if (closes) {
      return closes;
    }
  }
  return null;
}

function closesFromDexBars(bytes) {
  const text = Buffer.from(bytes).toString("latin1");
  if (!text.startsWith("\n1.0.0")) {
    return null;
  }
  const raw = text.match(/\d+\.\d+/g) || [];
  const numbers = raw[0] === "1.0" ? raw.slice(1) : raw;
  if (numbers.length < 9 || numbers.length % 9 !== 0) {
    return null;
  }
  const closes = [];
  for (let index = 7; index < numbers.length; index += 9) {
    const value = Number(numbers[index]);
    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }
    closes.push(value);
  }
  return closes.length >= 2 ? closes : null;
}

function logoUrl(pair) {
  const candidates = [pair?.info?.imageUrl, pair?.baseToken?.logoURI, pair?.baseToken?.logo];
  for (const value of candidates) {
    if (typeof value === "string" && value.startsWith("https://")) {
      return value;
    }
  }
  return "";
}

async function loadLogo(pair) {
  const url = logoUrl(pair);
  return url ? fetchBytes(url, 2_000_000) : null;
}

async function fetchBytes(url, maxBytes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      headers: { accept: "*/*", "user-agent": "blarc-card" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > maxBytes) {
      return null;
    }
    return bytes;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function roundedImage(bytes, size, radius) {
  const resized = await sharp(bytes).resize(size, size, { fit: "cover" }).png().toBuffer();
  const mask = Buffer.from(
    `<svg width="${size}" height="${size}"><rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`,
  );
  const cutout = await sharp(mask).png().toBuffer();
  return sharp(resized).composite([{ input: cutout, blend: "dest-in" }]).png().toBuffer();
}

function renderCardSvg(pair, closes) {
  const symbol = clip(pair?.baseToken?.symbol || "TOKEN", 12);
  const quote = clip(pair?.quoteToken?.symbol || "?", 8);
  const name = clip(pair?.baseToken?.name || symbol, 18);
  const changeNumber = Number(pair?.priceChange?.h24);
  const change = formatChange(changeNumber);
  const changeColor = !Number.isFinite(changeNumber) ? "#a9bdd0" : changeNumber >= 0 ? "#69e6a2" : "#ff7b8a";
  const letter = xml((symbol || "?").slice(0, 1).toUpperCase());
  const chart = closes ? chartMarkup(closes, changeNumber >= 0) : unavailableMarkup();

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#08111a"/>
  <rect width="${WIDTH}" height="10" fill="#47b8ff"/>
  <circle cx="140" cy="140" r="84" fill="#142b3d"/>
  <text x="140" y="158" text-anchor="middle" fill="#edf7ff" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="72" font-weight="700">${letter}</text>
  <text x="252" y="118" fill="#edf7ff" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="52" font-weight="700">${xml(name)}</text>
  <text x="252" y="178" fill="#a9bdd0" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="36">${xml(symbol)}/${xml(quote)}</text>
  <text x="252" y="236" fill="${changeColor}" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="40" font-weight="700">${xml(change)} 24h</text>
  <text x="64" y="360" fill="#a9bdd0" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="24">PRICE</text>
  <text x="64" y="448" fill="#edf7ff" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="78" font-weight="700">${xml(formatUsd(pair?.priceUsd))}</text>
  ${statBox(64, 500, "LIQUIDITY", formatUsd(pair?.liquidity?.usd))}
  ${statBox(392, 500, "MARKET CAP", formatUsd(pair?.marketCap || pair?.fdv))}
  ${statBox(720, 500, "PAIR AGE", formatAge(pair?.pairCreatedAt))}
  <rect x="48" y="700" width="984" height="580" rx="28" fill="#101f2d"/>
  ${chart}
</svg>`;
}

function statBox(x, y, label, value) {
  return `<rect x="${x}" y="${y}" width="296" height="150" rx="22" fill="#101f2d"/>
  <text x="${x + 24}" y="${y + 52}" fill="#a9bdd0" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="22">${xml(label)}</text>
  <text x="${x + 24}" y="${y + 108}" fill="#edf7ff" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="36" font-weight="700">${xml(clip(value, 14))}</text>`;
}

function unavailableMarkup() {
  return `<text x="540" y="1005" text-anchor="middle" fill="#a9bdd0" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="40">Chart unavailable</text>`;
}

function chartMarkup(closes, up) {
  const color = up ? "#69e6a2" : "#ff7b8a";
  const points = chartPoints(closes);
  const line = points.map((point) => `${point[0].toFixed(1)},${point[1].toFixed(1)}`).join(" ");
  const first = points[0];
  const last = points[points.length - 1];
  const area = `${first[0].toFixed(1)},1180 ${line} ${last[0].toFixed(1)},1180`;
  return `<text x="80" y="752" fill="#a9bdd0" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="22">15m</text>
  <polygon points="${area}" fill="${color}" opacity="0.16"/>
  <polyline points="${line}" fill="none" stroke="${color}" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>`;
}

function chartPoints(closes) {
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || Math.abs(max) || 1;
  const left = 88;
  const top = 800;
  const width = 904;
  const height = 380;
  return closes.map((value, index) => {
    const x = left + (closes.length === 1 ? width / 2 : (index / (closes.length - 1)) * width);
    const y = top + height - ((value - min) / span) * height;
    return [x, y];
  });
}

function formatChange(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "n/a";
  }
  return `${number > 0 ? "+" : ""}${number.toFixed(2)}%`;
}

function formatAge(timestampMs) {
  const created = Number(timestampMs);
  if (!Number.isFinite(created) || created <= 0) {
    return "n/a";
  }
  const ageMs = Date.now() - created;
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

function clip(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
