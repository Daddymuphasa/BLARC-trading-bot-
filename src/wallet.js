import QRCode from "qrcode";
import { SignClient } from "@walletconnect/sign-client";
import { getSdkError } from "@walletconnect/utils";

export const FEE_BPS = 100;

const EVM_METHODS = ["eth_sendTransaction", "personal_sign"];
const EVM_EVENTS = ["chainChanged", "accountsChanged"];
const OPTIONAL_CHAINS = ["eip155:1", "eip155:8453", "eip155:42161", "eip155:10", "eip155:137", "eip155:56"];

let clientPromise;
const sessionTopicByChat = new Map();

export function walletConnectProjectId() {
  return String(process.env.WALLETCONNECT_PROJECT_ID || "").trim();
}

export function isSolanaAddress(value) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(value || ""));
}

export function feeWalletStatus() {
  const evm = String(process.env.BLARC_FEE_ADDRESS || "").trim();
  const sol = String(process.env.BLARC_FEE_ADDRESS_SOL || "").trim();
  const robinhood = String(process.env.BLARC_FEE_ADDRESS_ROBINHOOD || "").trim();
  const arc = String(process.env.BLARC_FEE_ADDRESS_ARC || "").trim();
  const evmOk = isEvmAddress(evm);
  const solOk = isSolanaAddress(sol);
  const robinhoodOk = isEvmAddress(robinhood);
  const arcOk = isEvmAddress(arc);
  if (!evm && !sol && !robinhood && !arc) {
    return { state: "missing" };
  }
  if ((evm && !evmOk) || (sol && !solOk) || (robinhood && !robinhoodOk) || (arc && !arcOk)) {
    return {
      state: "invalid",
      evm: evmOk ? evm : null,
      sol: solOk ? sol : null,
      robinhood: robinhoodOk ? robinhood : null,
      arc: arcOk ? arc : null,
    };
  }
  return {
    state: "ok",
    address: evmOk ? evm : null,
    evm: evmOk ? evm : null,
    sol: solOk ? sol : null,
    robinhood: robinhoodOk ? robinhood : null,
    arc: arcOk ? arc : null,
  };
}

export function isEvmAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || ""));
}

export function sanitizeWallet(wallet) {
  if (!wallet || typeof wallet !== "object") {
    return null;
  }
  const address = typeof wallet.address === "string" ? wallet.address : "";
  const chainId = typeof wallet.chainId === "string" ? wallet.chainId : "";
  if (!isEvmAddress(address) || !/^eip155:\d+$/.test(chainId)) {
    return null;
  }
  return { address, chainId };
}

export function looksLikeSecretMaterial(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return false;
  }
  if (/0x[a-fA-F0-9]{64}\b/.test(raw) || /(^|\s)[a-fA-F0-9]{64}($|\s)/.test(raw)) {
    return true;
  }
  const words = raw.toLowerCase().split(/\s+/);
  if ([12, 15, 18, 24].includes(words.length) && words.every((word) => /^[a-z]{3,8}$/.test(word))) {
    return true;
  }
  return false;
}

export function publicWalletFromSession(session) {
  const accounts = session?.namespaces?.eip155?.accounts;
  if (!Array.isArray(accounts)) {
    return null;
  }
  for (const account of accounts) {
    const parts = String(account).split(":");
    if (parts.length < 3 || parts[0] !== "eip155" || !/^\d+$/.test(parts[1])) {
      continue;
    }
    const address = parts.slice(2).join(":");
    if (!isEvmAddress(address)) {
      continue;
    }
    return { address, chainId: `eip155:${parts[1]}` };
  }
  return null;
}

export function parseSwapCommand(args) {
  if (!Array.isArray(args) || args.length !== 3) {
    return { error: "usage" };
  }
  const [amount, tokenIn, tokenOut] = args;
  if (!parsePositiveDecimal(amount)) {
    return { error: "amount" };
  }
  if (!isTokenRef(tokenIn) || !isTokenRef(tokenOut)) {
    return { error: "token" };
  }
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
    return { error: "same" };
  }
  return { amount: String(amount).trim().replaceAll(",", "").replace(/^\$/, ""), tokenIn, tokenOut };
}

export function buildSwapPreview({ amount, tokenIn, tokenOut, wallet, feeAddress }) {
  const split = splitFee(amount);
  const account = sanitizeWallet(wallet);
  if (!split || !account || !isEvmAddress(feeAddress)) {
    return null;
  }
  return {
    amount: split.amount,
    fee: split.fee,
    net: split.net,
    bps: FEE_BPS,
    tokenIn,
    tokenOut,
    address: account.address,
    chainId: account.chainId,
    feeAddress,
  };
}

export function publicWalletError(error) {
  const message = String(error?.message || "WalletConnect pairing failed").replace(/\s+/g, " ").trim();
  if (!message || /wc:|sym=|seed|mnemonic|private key/i.test(message)) {
    return "WalletConnect pairing failed.";
  }
  return message.slice(0, 180);
}

export async function pairingQrPng(uri) {
  return QRCode.toBuffer(uri, {
    type: "png",
    width: 480,
    margin: 1,
    errorCorrectionLevel: "M",
  });
}

export async function beginPairing() {
  if (!walletConnectProjectId()) {
    throw new Error("WALLETCONNECT_PROJECT_ID is not set");
  }
  const client = await withTimeout(getClient(), 20000, "WalletConnect did not start in time.");
  const { uri, approval } = await withTimeout(
    client.connect({
      optionalNamespaces: {
        eip155: {
          chains: OPTIONAL_CHAINS,
          methods: EVM_METHODS,
          events: EVM_EVENTS,
        },
      },
    }),
    20000,
    "WalletConnect did not return a pairing URI in time.",
  );
  if (!uri || !approval) {
    throw new Error("WalletConnect did not return a pairing URI.");
  }
  return { uri, approval };
}

export async function adoptSession(chatId, topic) {
  if (!topic) {
    return;
  }
  const key = String(chatId);
  const previous = sessionTopicByChat.get(key);
  sessionTopicByChat.set(key, topic);
  if (previous && previous !== topic) {
    await disconnectTopic(previous);
  }
}

export async function dropChatSession(chatId) {
  const key = String(chatId);
  const topic = sessionTopicByChat.get(key);
  sessionTopicByChat.delete(key);
  if (topic) {
    await disconnectTopic(topic);
  }
}

export async function disconnectTopic(topic) {
  if (!topic || !clientPromise) {
    return;
  }
  try {
    const client = await clientPromise;
    await client.disconnect({
      topic,
      reason: getSdkError("USER_DISCONNECTED"),
    });
  } catch {
    // The in-memory session is already dropped. Nothing user-facing is stored.
  }
}

function createMemoryStorage() {
  const store = new Map();
  return {
    async getKeys() {
      return [...store.keys()];
    },
    async getEntries() {
      return [...store.entries()].map(([key, value]) => [key, cloneJson(value)]);
    },
    async getItem(key) {
      if (!store.has(key)) {
        return undefined;
      }
      return cloneJson(store.get(key));
    },
    async setItem(key, value) {
      store.set(key, cloneJson(value));
    },
    async removeItem(key) {
      store.delete(key);
    },
  };
}


function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function getClient() {
  const projectId = walletConnectProjectId();
  if (!projectId) {
    throw new Error("WALLETCONNECT_PROJECT_ID is not set");
  }
  if (!clientPromise) {
    clientPromise = SignClient.init({
      projectId,
      logger: "silent",
      telemetryEnabled: false,
      storage: createMemoryStorage(),
      metadata: {
        name: "BLARC",
        description: "Non-custodial BLARC Telegram bot. Keys stay in the user's wallet.",
        url: "https://t.me/theBLARCbot",
        icons: ["https://walletconnect.com/walletconnect-logo.png"],
      },
    }).catch((error) => {
      clientPromise = undefined;
      throw error;
    });
  }
  return clientPromise;
}

function isTokenRef(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(value) || /^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(value);
}

function parsePositiveDecimal(raw) {
  const cleaned = String(raw || "").trim().replaceAll(",", "").replace(/^\$/, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) {
    return null;
  }
  const [whole, frac = ""] = cleaned.split(".");
  if (whole.length + frac.length > 40) {
    return null;
  }
  const base = BigInt(whole) * 10n ** BigInt(frac.length) + BigInt(frac || "0");
  if (base <= 0n) {
    return null;
  }
  return { whole, frac };
}

function splitFee(raw) {
  const parsed = parsePositiveDecimal(raw);
  if (!parsed) {
    return null;
  }
  const scale = parsed.frac.length;
  const base = BigInt(parsed.whole) * 10n ** BigInt(scale) + BigInt(parsed.frac || "0");
  if (base <= 0n) {
    return null;
  }
  const extra = 8;
  const scaled = base * 10n ** BigInt(extra);
  const fee = (scaled * BigInt(FEE_BPS)) / 10000n;
  const net = scaled - fee;
  const displayScale = scale + extra;
  return {
    amount: formatScaled(scaled, displayScale),
    fee: formatScaled(fee, displayScale),
    net: formatScaled(net, displayScale),
  };
}

function formatScaled(value, scale) {
  const digits = value.toString().padStart(scale + 1, "0");
  const cut = digits.length - scale;
  const whole = digits.slice(0, cut);
  const frac = digits.slice(cut).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

function cloneJson(value) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}
