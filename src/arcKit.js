// Circle App Kits (Bridge Kit + Swap Kit) wired to the user's own WalletConnect wallet.
// BLARC never signs. Every approval, permit, burn, and swap is a request the user approves in their wallet.
// Fee rule matches the rest of BLARC: the 1% goes inside the operation, or nothing is built.
import { BridgeKit } from "@circle-fin/bridge-kit";
import { SwapKit } from "@circle-fin/swap-kit";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
import { createPublicClient, http } from "viem";
import { FEE_BPS, ARC_CHAIN_ID, feeWalletForChain, isEvmAddress, requestWalletRpc, walletSessionInfo } from "./wallet.js";

// Mainnet chains BLARC offers for Bridge. All are Bridge Kit mainnet chains with Forwarding Service
// destination support, so the user signs only on the source chain and Circle mints on the destination.
export const BRIDGE_CHAINS = [
  { id: 5042, kit: "Arc", label: "Arc", rpc: "https://rpc.mainnet.arc.io" },
  { id: 8453, kit: "Base", label: "Base", rpc: "https://base.publicnode.com" },
  { id: 1, kit: "Ethereum", label: "Ethereum", rpc: "https://ethereum.publicnode.com" },
  { id: 42161, kit: "Arbitrum", label: "Arbitrum", rpc: "https://arbitrum-one.publicnode.com" },
  { id: 10, kit: "Optimism", label: "Optimism", rpc: "https://optimism.publicnode.com" },
  { id: 137, kit: "Polygon", label: "Polygon", rpc: "https://polygon-bor.publicnode.com" },
  { id: 43114, kit: "Avalanche", label: "Avalanche", rpc: "https://avalanche-c-chain.publicnode.com" },
  { id: 130, kit: "Unichain", label: "Unichain", rpc: "https://unichain-rpc.publicnode.com" },
  { id: 59144, kit: "Linea", label: "Linea", rpc: "https://linea-rpc.publicnode.com" },
];

// Swap Kit on Arc accepts only these three tokens (docs.arc.io/app-kit/swap).
export const ARC_SWAP_TOKENS = {
  USDC: { alias: "USDC", address: "0x3600000000000000000000000000000000000000", decimals: 6 },
  EURC: { alias: "EURC", address: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1", decimals: 6 },
  CIRBTC: { alias: "cirBTC", address: "0x171A4217b86A807A64eB94757Db6849fb4bDbAA0", decimals: 8 },
};

const USDC_DECIMALS = 6;
const APPROVE = "0x095ea7b3";
const INCREASE_ALLOWANCE = "0x39509351";

let bridgeKitSingleton;
function bridgeKit() {
  bridgeKitSingleton = bridgeKitSingleton || new BridgeKit();
  return bridgeKitSingleton;
}

export function circleApiKey() {
  return String(process.env.CIRCLE_API_KEY || process.env.KIT_KEY || "").trim();
}

export function bridgeChain(id) {
  return BRIDGE_CHAINS.find((c) => c.id === Number(id)) || null;
}

function chainDefinition(kitName) {
  return bridgeKit().getSupportedChains({ isTestnet: false }).find((c) => c.chain === kitName) || null;
}

function rpcFor(chainId) {
  const known = bridgeChain(chainId);
  if (known) {
    return known.rpc;
  }
  const def = bridgeKit().getSupportedChains().find((c) => c.chainId === Number(chainId));
  return def?.rpcEndpoints?.[0] || null;
}

// Sources are the bridge chains the user's live WalletConnect session actually granted.
export async function bridgeSources(chatId) {
  const info = await walletSessionInfo(chatId);
  if (!info?.address) {
    return { info: null, chains: [] };
  }
  return { info, chains: BRIDGE_CHAINS.filter((c) => info.chainIds.has(c.id)) };
}

export function bridgeDestinations(sourceId) {
  return BRIDGE_CHAINS.filter((c) => c.id !== Number(sourceId)).filter((c) => {
    const def = chainDefinition(c.kit);
    return def?.cctp?.forwarderSupported?.destination === true;
  });
}

export function toUnits(amount, decimals) {
  const raw = String(amount || "").trim().replaceAll(",", "");
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    return null;
  }
  const [whole, frac = ""] = raw.split(".");
  if (frac.length > decimals) {
    return null;
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export function fromUnits(value, decimals) {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

// 1% of the bridge amount, in USDC, as a decimal string. Null if the amount is invalid or too small.
export function bridgeFeeFor(amount) {
  const units = toUnits(amount, USDC_DECIMALS);
  if (units == null || units <= 0n) {
    return null;
  }
  const fee = (units * BigInt(FEE_BPS)) / 10000n;
  if (fee <= 0n) {
    return null;
  }
  return { amountUnits: units, feeUnits: fee, fee: fromUnits(fee, USDC_DECIMALS) };
}

function lowerSet(values) {
  return new Set(values.filter((v) => isEvmAddress(v)).map((v) => v.toLowerCase()));
}

function kitContractSet(def) {
  const v2 = def?.cctp?.contracts?.v2 || {};
  return lowerSet([
    def?.kitContracts?.bridge,
    def?.kitContracts?.adapter,
    def?.kitContracts?.senderPreservingBatcher,
    v2.tokenMessenger,
    v2.tokenMessengerWithFees,
    v2.messageTransmitter,
    def?.cctpx?.serviceAddress,
  ]);
}

function decodeApproval(data) {
  const hex = String(data || "").toLowerCase();
  const selector = hex.slice(0, 10);
  if ((selector !== APPROVE && selector !== INCREASE_ALLOWANCE) || hex.length < 138) {
    return null;
  }
  return { spender: `0x${hex.slice(34, 74)}`, amount: BigInt(`0x${hex.slice(74, 138)}`) };
}

function toBig(value) {
  try {
    return BigInt(value ?? 0);
  } catch {
    return -1n;
  }
}

class GuardError extends Error {}

// EIP-1193 provider: reads go to a public RPC; signing goes to the user's wallet through WalletConnect,
// only after the guard checks the chain, the contract, and the approval size.
function walletConnectProvider({ chatId, address, chainId, guard }) {
  let current = Number(chainId);
  const listeners = new Map();
  return {
    async request({ method, params }) {
      switch (method) {
        case "eth_accounts":
        case "eth_requestAccounts":
          return [address];
        case "eth_chainId":
          return `0x${current.toString(16)}`;
        case "wallet_switchEthereumChain": {
          const next = Number.parseInt(String(params?.[0]?.chainId || ""), 16);
          if (!Number.isSafeInteger(next)) {
            throw Object.assign(new Error("Bad chain id"), { code: 4902 });
          }
          current = next;
          return null;
        }
        case "wallet_getCapabilities":
        case "wallet_sendCalls":
        case "wallet_addEthereumChain":
          throw Object.assign(new Error("Unsupported by this wallet bridge"), { code: 4200 });
        case "eth_sendTransaction": {
          const tx = params?.[0] || {};
          guard.tx(current, tx);
          return requestWalletRpc(chatId, `eip155:${current}`, method, [{ ...tx, from: address }], address);
        }
        case "eth_signTypedData_v4": {
          const typed = typeof params?.[1] === "string" ? JSON.parse(params[1]) : params?.[1];
          guard.typed(current, typed);
          return requestWalletRpc(chatId, `eip155:${current}`, method, [address, JSON.stringify(typed)], address);
        }
        case "personal_sign":
        case "eth_sign":
        case "eth_signTransaction":
          throw Object.assign(new Error("BLARC does not request that signature"), { code: 4200 });
        default: {
          const url = rpcFor(current);
          if (!url) {
            throw new Error("No public RPC for that chain.");
          }
          const response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
          });
          const body = await response.json();
          if (body.error) {
            throw Object.assign(new Error(body.error.message || "RPC error"), { code: body.error.code });
          }
          return body.result;
        }
      }
    },
    on(event, fn) {
      listeners.set(fn, event);
    },
    removeListener(event, fn) {
      listeners.delete(fn);
    },
  };
}

async function adapterFor(provider) {
  return createViemAdapterFromProvider({
    provider,
    getPublicClient: ({ chain }) => createPublicClient({ chain, transport: http(rpcFor(chain.id) || undefined) }),
  });
}

function bridgeGuard({ source, maxApproval }) {
  const def = chainDefinition(source.kit);
  const allowed = kitContractSet(def);
  const usdc = String(def?.usdcAddress || "").toLowerCase();
  return {
    tx(chainId, tx) {
      if (chainId !== source.id) {
        throw new GuardError("The bridge asked for a signature on another chain, so it was stopped.");
      }
      const to = String(tx.to || "").toLowerCase();
      const value = toBig(tx.value);
      if (to === usdc) {
        const approval = decodeApproval(tx.data);
        if (!approval || !allowed.has(approval.spender) || approval.amount > maxApproval) {
          throw new GuardError("The token approval did not match this bridge, so it was stopped.");
        }
        if (value !== 0n) {
          throw new GuardError("The approval carried a coin value, so it was stopped.");
        }
        return;
      }
      if (!allowed.has(to)) {
        throw new GuardError("The bridge pointed at an unknown contract, so it was stopped.");
      }
      // On Arc, USDC is also the native coin (18 decimals). Never let value exceed amount + fee.
      const maxValue = source.id === ARC_CHAIN_ID ? maxApproval * 10n ** 12n : 0n;
      if (value < 0n || value > maxValue) {
        throw new GuardError("The bridge asked for more value than you chose, so it was stopped.");
      }
    },
    typed() {
      throw new GuardError("The bridge asked for an off-chain signature BLARC does not expect, so it was stopped.");
    },
  };
}

function friendlyKitError(error) {
  if (error instanceof GuardError) {
    return error.message;
  }
  const text = String(error?.message || "").replace(/\s+/g, " ").trim();
  const code = error?.code ?? error?.cause?.code ?? error?.cause?.trace?.originalError?.code;
  if (code === 4001 || code === 1099 || /reject|cancel|denied/i.test(text)) {
    return "You declined in your wallet.";
  }
  if (/insufficient/i.test(text)) {
    return text.slice(0, 140);
  }
  if (/session|connect again/i.test(text)) {
    return text.slice(0, 160);
  }
  if (/did not respond in time/i.test(text)) {
    return "Your wallet did not respond in time.";
  }
  if (!text || /wc:|sym=|seed|mnemonic|private key|apikey|api key/i.test(text)) {
    return "The request failed.";
  }
  return text.slice(0, 160);
}

function bridgeParams({ adapter, source, destination, address, amount, fee, feeAddress }) {
  return {
    from: { adapter, chain: source.kit },
    to: { chain: destination.kit, recipientAddress: address, useForwarder: true },
    amount: fromUnits(toUnits(amount, USDC_DECIMALS), USDC_DECIMALS),
    token: "USDC",
    config: { transferSpeed: "FAST", customFee: { value: fee, recipientAddress: feeAddress } },
  };
}

function bridgeFeeWallet(sourceId) {
  const fee = feeWalletForChain(`eip155:${sourceId}`);
  if (fee.error || !isEvmAddress(fee.address)) {
    return null;
  }
  return fee.address;
}

function sumFees(fees, types) {
  let total = 0n;
  for (const item of Array.isArray(fees) ? fees : []) {
    if (types.includes(item?.type) && String(item?.token || "").toUpperCase() === "USDC") {
      const units = toUnits(String(item.amount), 18);
      if (units != null) {
        total += units / 10n ** 12n;
      }
    }
  }
  return total;
}

function kitFeeOk(fees, feeUnits) {
  const kit = (Array.isArray(fees) ? fees : []).filter((f) => f?.type === "kit");
  if (kit.length !== 1) {
    return false;
  }
  const units = toUnits(String(kit[0].amount), 18);
  return units != null && units / 10n ** 12n === feeUnits;
}

// Quote step for the confirm screen. Builds nothing and asks the wallet for nothing.
export async function quoteBridge({ chatId, address, sourceId, destinationId, amount }) {
  const source = bridgeChain(sourceId);
  const destination = bridgeChain(destinationId);
  if (!source || !destination || source.id === destination.id) {
    return { error: "Pick two different chains." };
  }
  if (!isEvmAddress(address)) {
    return { error: "Connect an EVM wallet first." };
  }
  const split = bridgeFeeFor(amount);
  if (!split) {
    return { error: "That amount is too small to bridge." };
  }
  const feeAddress = bridgeFeeWallet(source.id);
  if (!feeAddress) {
    return { error: "The bridge setup is incomplete." };
  }
  try {
    const provider = walletConnectProvider({
      chatId,
      address,
      chainId: source.id,
      guard: { tx() { throw new GuardError("Quote only."); }, typed() { throw new GuardError("Quote only."); } },
    });
    const adapter = await adapterFor(provider);
    const estimate = await bridgeKit().estimate(bridgeParams({ adapter, source, destination, address, amount, fee: split.fee, feeAddress }));
    if (!kitFeeOk(estimate?.fees, split.feeUnits)) {
      console.error("bridge quote rejected: fee");
      return { error: "The bridge quote could not be used." };
    }
    const deducted = sumFees(estimate?.fees, ["provider", "forwarder"]);
    const arrive = split.amountUnits - deducted;
    if (arrive <= 0n) {
      return { error: "That amount is too small after network costs." };
    }
    return {
      source,
      destination,
      amount: fromUnits(split.amountUnits, USDC_DECIMALS),
      arrive: fromUnits(arrive, USDC_DECIMALS),
      gasToken: source.id === ARC_CHAIN_ID ? "USDC" : "the chain's gas coin",
    };
  } catch (error) {
    console.error("bridge quote failed:", friendlyKitError(error));
    return { error: `The bridge quote failed. ${friendlyKitError(error)}` };
  }
}

// Runs the bridge. The user approves in their wallet (approve, then burn). Circle's Forwarding
// Service mints on the destination, so no second-chain signature is needed.
export async function runBridge({ chatId, address, sourceId, destinationId, amount, onProgress }) {
  const source = bridgeChain(sourceId);
  const destination = bridgeChain(destinationId);
  const split = bridgeFeeFor(amount);
  const feeAddress = source ? bridgeFeeWallet(source.id) : null;
  if (!source || !destination || !split || !feeAddress || !isEvmAddress(address)) {
    return { ok: false, text: "Bridge could not be prepared. Nothing was signed." };
  }
  const guard = bridgeGuard({ source, maxApproval: split.amountUnits + split.feeUnits });
  const provider = walletConnectProvider({ chatId, address, chainId: source.id, guard });
  const kit = new BridgeKit();
  const steps = [];
  kit.on("*", (payload) => {
    const name = String(payload?.method || payload?.name || "");
    const hash = payload?.values?.txHash || payload?.txHash;
    steps.push({ name, hash });
    if (typeof onProgress === "function") {
      Promise.resolve(onProgress({ name, hash, source, destination })).catch(() => {});
    }
  });
  let result;
  try {
    const adapter = await adapterFor(provider);
    const params = bridgeParams({ adapter, source, destination, address, amount, fee: split.fee, feeAddress });
    const estimate = await kit.estimate(params);
    if (!kitFeeOk(estimate?.fees, split.feeUnits)) {
      return { ok: false, text: "Bridge could not be prepared. The quote could not be used. Nothing was signed." };
    }
    result = await kit.bridge(params);
  } catch (error) {
    return { ok: false, text: `Bridge not completed. ${friendlyKitError(error)} Nothing further was sent.` };
  }
  const resultSteps = Array.isArray(result?.steps) ? result.steps : [];
  const burn = resultSteps.find((s) => /burn/i.test(String(s?.name || "")));
  const mint = resultSteps.find((s) => /mint/i.test(String(s?.name || "")));
  const failed = resultSteps.find((s) => s?.state === "error");
  return {
    ok: result?.state === "success",
    state: result?.state || "error",
    source,
    destination,
    amount: fromUnits(split.amountUnits, USDC_DECIMALS),
    burnHash: burn?.txHash || null,
    burnUrl: burn?.explorerUrl || null,
    mintHash: mint?.txHash || null,
    mintUrl: mint?.explorerUrl || null,
    failedStep: failed ? String(failed.name || "") : null,
    failedReason: failed ? friendlyKitError(failed.error || { message: failed.errorMessage }) : null,
  };
}

export function arcSwapToken(ref) {
  const raw = String(ref || "").trim();
  const bySymbol = ARC_SWAP_TOKENS[raw.toUpperCase()];
  if (bySymbol) {
    return bySymbol;
  }
  if (isEvmAddress(raw)) {
    return Object.values(ARC_SWAP_TOKENS).find((t) => t.address.toLowerCase() === raw.toLowerCase()) || null;
  }
  return null;
}

export function isArcKitPair(tokenIn, tokenOut) {
  const a = arcSwapToken(tokenIn);
  const b = arcSwapToken(tokenOut);
  return Boolean(a && b && a.address !== b.address);
}

function arcSwapGuard({ sell, sellUnits }) {
  const def = chainDefinition("Arc");
  const allowed = kitContractSet(def);
  const tokens = lowerSet(Object.values(ARC_SWAP_TOKENS).map((t) => t.address));
  const isUsdc = sell.address.toLowerCase() === ARC_SWAP_TOKENS.USDC.address.toLowerCase();
  return {
    tx(chainId, tx) {
      if (chainId !== ARC_CHAIN_ID) {
        throw new GuardError("The swap asked for a signature on another chain, so it was stopped.");
      }
      const to = String(tx.to || "").toLowerCase();
      const value = toBig(tx.value);
      if (tokens.has(to)) {
        const approval = decodeApproval(tx.data);
        if (!approval || !allowed.has(approval.spender) || approval.amount > sellUnits || value !== 0n) {
          throw new GuardError("The token approval did not match this swap, so it was stopped.");
        }
        return;
      }
      if (!allowed.has(to)) {
        throw new GuardError("The swap pointed at an unknown contract, so it was stopped.");
      }
      const maxValue = isUsdc ? sellUnits * 10n ** 12n : 0n;
      if (value < 0n || value > maxValue) {
        throw new GuardError("The swap asked for more value than you chose, so it was stopped.");
      }
    },
    typed(chainId, typed) {
      const domainChain = Number(typed?.domain?.chainId);
      const message = typed?.message || {};
      const spender = String(message.spender || "").toLowerCase();
      const token = String(typed?.domain?.verifyingContract || "").toLowerCase();
      if (chainId !== ARC_CHAIN_ID || domainChain !== ARC_CHAIN_ID) {
        throw new GuardError("The swap permit was for another chain, so it was stopped.");
      }
      if (typed?.primaryType !== "Permit" || !tokens.has(token) || !allowed.has(spender) || toBig(message.value) > sellUnits || toBig(message.value) < 0n) {
        console.error("arc swap permit refused:", typed?.primaryType || "unknown");
        throw new GuardError("The swap permit did not match this swap, so it was stopped.");
      }
    },
  };
}

function developerFeeOk(fees, { sell, sellUnits, feeAddress }) {
  const dev = (Array.isArray(fees) ? fees : []).filter((f) => f?.type === "developer");
  if (dev.length !== 1) {
    return false;
  }
  const item = dev[0];
  if (String(item.recipientAddress || "").toLowerCase() !== feeAddress.toLowerCase()) {
    return false;
  }
  const units = toUnits(String(item.amount), 30);
  if (units == null) {
    return false;
  }
  const got = units / 10n ** BigInt(30 - sell.decimals);
  const expected = (sellUnits * BigInt(FEE_BPS)) / 10000n;
  const diff = got > expected ? got - expected : expected - got;
  return expected > 0n && diff <= 1n;
}

// Arc swap through Circle Swap Kit (USDC, EURC, cirBTC). Fee: 1% developer fee inside the swap.
export async function executeArcKitSwap({ chatId, address, amount, tokenIn, tokenOut, feeAddress }) {
  const sell = arcSwapToken(tokenIn);
  const buy = arcSwapToken(tokenOut);
  if (!sell || !buy || sell.address === buy.address) {
    return { ok: false, text: "Swap could not be prepared. On Arc, pick two of USDC, EURC, or cirBTC." };
  }
  if (!isEvmAddress(feeAddress)) {
    return { ok: false, text: "Swap could not be prepared. The Arc swap setup is incomplete." };
  }
  const sellUnits = toUnits(amount, sell.decimals);
  if (sellUnits == null || (sellUnits * BigInt(FEE_BPS)) / 10000n <= 0n) {
    return { ok: false, text: "Swap could not be prepared. This amount is too small to swap." };
  }
  const info = await walletSessionInfo(chatId);
  if (!info?.chainIds?.has(ARC_CHAIN_ID)) {
    return { ok: false, text: "Swap could not be prepared. Your wallet session does not include Arc. Add Arc (chain 5042) in your wallet, then reconnect. Nothing was signed." };
  }
  if (!info.methods.has("eth_signTypedData_v4")) {
    return { ok: false, text: "Swap could not be prepared. Reconnect your wallet once so it can sign the Arc swap permit. Nothing was signed." };
  }
  const provider = walletConnectProvider({ chatId, address, chainId: ARC_CHAIN_ID, guard: arcSwapGuard({ sell, sellUnits }) });
  const config = { customFee: { percentageBps: FEE_BPS, recipientAddress: feeAddress } };
  const apiKey = circleApiKey();
  if (apiKey) {
    config.apiKey = apiKey;
  }
  try {
    const adapter = await adapterFor(provider);
    const kit = new SwapKit();
    const params = {
      from: { adapter, chain: "Arc" },
      tokenIn: sell.alias,
      tokenOut: buy.alias,
      amountIn: fromUnits(sellUnits, sell.decimals),
      config,
    };
    const estimate = await kit.estimate(params);
    if (!developerFeeOk(estimate?.fees, { sell, sellUnits, feeAddress })) {
      console.error("arc swap quote rejected: fee");
      return { ok: false, text: "Swap could not be prepared. The quote could not be used. Nothing was signed." };
    }
    const result = await kit.swap(params);
    return {
      ok: true,
      sell,
      buy,
      amount: fromUnits(sellUnits, sell.decimals),
      estimated: estimate?.estimatedOutput?.amount || null,
      minimum: estimate?.stopLimit?.amount || null,
      amountOut: result?.amountOut || null,
      hash: result?.txHash || null,
      url: result?.explorerUrl || (result?.txHash ? `https://explorer.arc.io/tx/${result.txHash}` : null),
    };
  } catch (error) {
    console.error("arc swap failed:", friendlyKitError(error));
    return { ok: false, text: `Swap not sent. ${friendlyKitError(error)} Nothing further was sent.` };
  }
}

// Pure helpers exposed for scripts/check-arc-kit.js. No network, no signing.
export const arcKitInternals = { bridgeGuard, arcSwapGuard, kitFeeOk, developerFeeOk };
