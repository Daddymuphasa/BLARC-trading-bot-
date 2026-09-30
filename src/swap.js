import { FEE_BPS, ROBINHOOD_CHAIN_ID, feeWalletForChain, hasWalletSession, isEvmAddress, requestWalletTransaction } from "./wallet.js";
import { escapeHtml } from "./telegram.js";

const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const SLIPPAGE_BPS = 100;
const QUOTE_URL = "https://api.0x.org/swap/allowance-holder/quote";

// Chains whose 0x Swap API support and public eth_chainId endpoint were both checked.
// Plasma (9745) and Tempo (4217) are on the 0x list but have no verified read endpoint here.
const READ_RPC = {
  1: "https://ethereum.publicnode.com",
  10: "https://optimism.publicnode.com",
  56: "https://bsc.publicnode.com",
  137: "https://polygon-bor.publicnode.com",
  8453: "https://base.publicnode.com",
  42161: "https://arbitrum-one.publicnode.com",
  43114: "https://avalanche-c-chain.publicnode.com",
  59144: "https://linea-rpc.publicnode.com",
  534352: "https://scroll.publicnode.com",
  5000: "https://mantle-rpc.publicnode.com",
  146: "https://rpc.soniclabs.com",
  80094: "https://rpc.berachain.com",
  130: "https://unichain-rpc.publicnode.com",
  4663: "https://rpc.mainnet.chain.robinhood.com",
  5042: "https://rpc.mainnet.arc.io",
  2741: "https://api.mainnet.abs.xyz",
  999: "https://rpc.hyperliquid.xyz/evm",
  57073: "https://rpc-gel.inkonchain.com",
  143: "https://rpc.monad.xyz",
  480: "https://worldchain-mainnet.g.alchemy.com/public",
};

const ZEROX_SWAP_CHAIN_IDS = new Set(Object.keys(READ_RPC).map((id) => Number(id)));

const KNOWN = {
  1: {
    ETH: [NATIVE, 18],
    WETH: ["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", 18],
    USDC: ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", 6],
    USDT: ["0xdac17f958d2ee523a2206206994597c13d831ec7", 6],
    DAI: ["0x6b175474e89094c44da98b954eedeac495271d0f", 18],
  },
  10: {
    ETH: [NATIVE, 18],
    WETH: ["0x4200000000000000000000000000000000000006", 18],
    USDC: ["0x0b2c639c533813f4aa9d7837caf62653d097ff85", 6],
    USDT: ["0x94b008aa00579c1307b0ef2c499ad98a8ce58e58", 6],
    DAI: ["0xda10009cbd5d07dd0cecc66161fc93d7c9000da1", 18],
  },
  56: {
    BNB: [NATIVE, 18],
    WBNB: ["0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", 18],
    USDC: ["0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", 18],
    USDT: ["0x55d398326f99059ff775485246999027b3197955", 18],
  },
  137: {
    POL: [NATIVE, 18],
    MATIC: [NATIVE, 18],
    WETH: ["0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", 18],
    USDC: ["0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", 6],
    USDT: ["0xc2132d05d31c914a87c6611c10748aeb04b58e8f", 6],
  },
  8453: {
    ETH: [NATIVE, 18],
    WETH: ["0x4200000000000000000000000000000000000006", 18],
    USDC: ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", 6],
  },
  42161: {
    ETH: [NATIVE, 18],
    WETH: ["0x82af49447d8a07e3bd95bd0d56f35241523fbab1", 18],
    USDC: ["0xaf88d065e77c8cc2239327c5edb3a432268e5831", 6],
    USDT: ["0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", 6],
    DAI: ["0xda10009cbd5d07dd0cecc66161fc93d7c9000da1", 18],
  },
  43114: {
    AVAX: [NATIVE, 18],
    WAVAX: ["0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7", 18],
    USDC: ["0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", 6],
  },
  4663: {
    ETH: [NATIVE, 18],
    WETH: ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", 18],
  },
};

const decimalsCache = new Map();

export function swapApiKey() {
  return String(process.env.ZEROX_API_KEY || "").trim();
}

export function expectedFeeBaseUnits(sellAmount) {
  return (BigInt(sellAmount) * BigInt(FEE_BPS)) / 10000n;
}

export function validateSwapQuote(quote, { sellToken, buyToken, sellAmount, feeAddress, native }) {
  if (!quote || typeof quote !== "object" || quote.liquidityAvailable !== true) {
    return { ok: false, reason: "no-liquidity" };
  }
  if (quote.issues?.balance) {
    return { ok: false, reason: "balance" };
  }
  if (quote.issues?.simulationIncomplete === true) {
    return { ok: false, reason: "simulation" };
  }
  const fees = Array.isArray(quote.fees?.integratorFees) ? quote.fees.integratorFees : null;
  if (fees && fees.length !== 1) {
    return { ok: false, reason: "fee-count" };
  }
  const fee = quote.fees?.integratorFee;
  if (!fee || fee.amount == null || !fee.token) {
    return { ok: false, reason: "no-fee" };
  }
  let feeAmount;
  let quotedSell;
  try {
    feeAmount = BigInt(fee.amount);
    quotedSell = BigInt(quote.sellAmount);
  } catch {
    return { ok: false, reason: "fee-amount" };
  }
  const expected = expectedFeeBaseUnits(sellAmount);
  if (expected <= 0n || feeAmount !== expected || quotedSell !== BigInt(sellAmount)) {
    return { ok: false, reason: "fee-amount" };
  }
  if (String(fee.token).toLowerCase() !== String(sellToken).toLowerCase()) {
    return { ok: false, reason: "fee-token" };
  }
  if (String(quote.sellToken || "").toLowerCase() !== String(sellToken).toLowerCase()) {
    return { ok: false, reason: "sell-token" };
  }
  if (String(quote.buyToken || "").toLowerCase() !== String(buyToken).toLowerCase()) {
    return { ok: false, reason: "buy-token" };
  }
  const tx = quote.transaction;
  if (!tx || !isEvmAddress(tx.to) || !isHexData(tx.data)) {
    return { ok: false, reason: "no-tx" };
  }
  if (tx.to.toLowerCase() === String(feeAddress).toLowerCase()) {
    return { ok: false, reason: "fee-not-in-swap" };
  }
  const padded = `000000000000000000000000${String(feeAddress).slice(2).toLowerCase()}`;
  if (!tx.data.toLowerCase().includes(padded)) {
    return { ok: false, reason: "fee-not-in-calldata" };
  }
  let value;
  try {
    value = BigInt(tx.value || "0");
  } catch {
    return { ok: false, reason: "value" };
  }
  if (native) {
    if (value !== BigInt(sellAmount)) {
      return { ok: false, reason: "value" };
    }
  } else if (value !== 0n) {
    return { ok: false, reason: "value" };
  }
  return { ok: true, feeAmount: expected };
}

export async function executeSwap({ chatId, wallet, amount, tokenIn, tokenOut }) {
  const fee = feeWalletForChain(wallet.chainId);
  if (fee.error === "missing" || fee.error === "invalid") {
    return refuse("The fee wallet is not set.");
  }
  if (fee.error === "unset") {
    return refuse(`The ${feeLabel(fee.family)} fee wallet is not set.`);
  }
  if (fee.error || !fee.address) {
    return refuse("This chain does not map to a fee wallet.");
  }
  if (fee.family === "sol") {
    return refuse("Solana swaps are refused. The 1% cannot be put in the same Solana transaction, so nothing was signed.");
  }
  if (fee.chainId === ROBINHOOD_CHAIN_ID) {
    return executeRobinhoodSwap({ chatId, wallet, amount, tokenIn, tokenOut, fee });
  }
  if (!ZEROX_SWAP_CHAIN_IDS.has(fee.chainId)) {
    return refuse("This chain has no verified in-swap fee quote, so no transaction was built.");
  }
  if (!swapApiKey()) {
    return refuse("ZEROX_API_KEY is not set, so no swap transaction was built.");
  }
  if (!hasWalletSession(chatId)) {
    return refuse("The WalletConnect session is not active. Run /connect again. Nothing was signed.");
  }

  let sell;
  let buy;
  try {
    sell = await resolveToken(fee.chainId, tokenIn);
    buy = await resolveToken(fee.chainId, tokenOut);
  } catch (error) {
    console.error("swap token read failed:", error?.code || "read");
    return refuse("The token amount could not be read on this chain, so no transaction was built.");
  }
  if (!sell || !buy) {
    return text(
      "Swap refused. Use a token contract address on this chain, or a known symbol such as ETH, WETH, USDC, USDT, or DAI where that symbol is listed. Nothing was sent.",
    );
  }
  if (sell.address.toLowerCase() === buy.address.toLowerCase()) {
    return text("Choose two different tokens. Nothing was sent.");
  }

  const sellAmount = toBaseUnits(amount, sell.decimals);
  if (sellAmount == null) {
    return text("Swap refused. That amount has more decimal places than the token. Nothing was sent.");
  }
  if (expectedFeeBaseUnits(sellAmount) <= 0n) {
    return refuse("1% of this amount rounds to zero in token units.");
  }

  let quote;
  try {
    quote = await fetchQuote({
      chainId: fee.chainId,
      sellToken: sell.address,
      buyToken: buy.address,
      sellAmount,
      taker: wallet.address,
      feeAddress: fee.address,
    });
  } catch (error) {
    console.error("swap quote failed:", error?.code || "quote");
    return refuse("The swap quote failed, so no transaction was built.");
  }

  const verdict = validateSwapQuote(quote, {
    sellToken: sell.address,
    buyToken: buy.address,
    sellAmount,
    feeAddress: fee.address,
    native: sell.address.toLowerCase() === NATIVE,
  });
  if (!verdict.ok) {
    console.error("swap quote rejected:", verdict.reason);
    return refuse("The quote did not put the 1% fee inside the swap transaction.");
  }

  const allowance = quote.issues?.allowance;
  if (allowance && !allowanceCovers(allowance, sellAmount)) {
    if (sell.address.toLowerCase() === NATIVE) {
      return refuse("The quote asked for an approval on the native coin, so nothing was signed.");
    }
    return requestApproval({
      chatId,
      wallet,
      sell,
      allowance,
      allowanceTarget: quote.allowanceTarget,
      sellAmount,
    });
  }

  const tx = buildSwapTx(wallet.address, quote.transaction);
  if (!tx) {
    return refuse("The quote did not include a signable swap transaction.");
  }
  let hash;
  try {
    hash = await requestWalletTransaction(chatId, wallet.chainId, tx);
  } catch (error) {
    console.error("swap signature failed:", safeError(error));
    return text(`Swap not sent. ${escapeHtml(safeError(error))} Nothing was signed by BLARC.`);
  }
  return text(signedSwapMessage({ wallet, sell, buy, amount, fee, quote, hash }));
}

function refuse(detail) {
  return text(`Fee cannot be included, swap not sent. ${detail}`);
}

function text(value) {
  return value;
}

function feeLabel(family) {
  if (family === "arc") return "Arc";
  if (family === "robinhood") return "Robinhood";
  if (family === "sol") return "Solana";
  if (family === "evm") return "EVM";
  return "matching";
}

async function resolveToken(chainId, ref) {
  const raw = String(ref || "").trim();
  if (isEvmAddress(raw)) {
    if (raw.toLowerCase() === NATIVE) {
      return { address: NATIVE, decimals: 18, label: "native" };
    }
    const decimals = await readDecimals(chainId, raw);
    return { address: raw, decimals, label: raw };
  }
  const known = KNOWN[chainId]?.[raw.toUpperCase()];
  if (!known) {
    return null;
  }
  return { address: known[0], decimals: known[1], label: raw.toUpperCase() };
}

async function readDecimals(chainId, token) {
  const rpc = READ_RPC[chainId];
  if (!rpc) {
    const error = new Error("no rpc");
    error.code = "no-rpc";
    throw error;
  }
  const key = `${chainId}:${token.toLowerCase()}`;
  if (decimalsCache.has(key)) {
    return decimalsCache.get(key);
  }
  const response = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": "blarc-bot" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: token, data: "0x313ce567" }, "latest"],
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) {
    const error = new Error("rpc http");
    error.code = "rpc";
    throw error;
  }
  const body = await response.json();
  if (body.error || !isHexData(body.result)) {
    const error = new Error("decimals");
    error.code = "decimals";
    throw error;
  }
  const decimals = Number(BigInt(body.result));
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    const error = new Error("decimals range");
    error.code = "decimals";
    throw error;
  }
  decimalsCache.set(key, decimals);
  return decimals;
}

function toBaseUnits(amount, decimals) {
  const cleaned = String(amount || "").trim();
  if (!/^\d+(\.\d+)?$/.test(cleaned)) {
    return null;
  }
  const [whole, frac = ""] = cleaned.split(".");
  if (frac.length > decimals) {
    return null;
  }
  const scale = 10n ** BigInt(decimals);
  return BigInt(whole) * scale + BigInt(frac.padEnd(decimals, "0") || "0");
}

async function fetchQuote({ chainId, sellToken, buyToken, sellAmount, taker, feeAddress }) {
  const url = new URL(QUOTE_URL);
  url.searchParams.set("chainId", String(chainId));
  url.searchParams.set("sellToken", sellToken);
  url.searchParams.set("buyToken", buyToken);
  url.searchParams.set("sellAmount", sellAmount.toString());
  url.searchParams.set("taker", taker);
  url.searchParams.set("swapFeeRecipient", feeAddress);
  url.searchParams.set("swapFeeBps", String(FEE_BPS));
  url.searchParams.set("swapFeeToken", sellToken);
  url.searchParams.set("slippageBps", String(SLIPPAGE_BPS));
  const response = await fetch(url, {
    headers: {
      "0x-api-key": swapApiKey(),
      "0x-version": "v2",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const error = new Error("quote http");
    error.code = `http-${response.status}`;
    throw error;
  }
  return response.json();
}

function allowanceCovers(allowance, sellAmount) {
  if (allowance.actual == null || allowance.actual === "") {
    return false;
  }
  try {
    return BigInt(allowance.actual) >= BigInt(sellAmount);
  } catch {
    return false;
  }
}

async function requestApproval({ chatId, wallet, sell, allowance, allowanceTarget, sellAmount }) {
  const spender = String(allowance.spender || "");
  if (!isEvmAddress(spender) || spender.toLowerCase() === wallet.address.toLowerCase()) {
    return refuse("The quote did not name a safe approval spender.");
  }
  if (allowanceTarget && String(allowanceTarget).toLowerCase() !== spender.toLowerCase()) {
    return refuse("The quote's approval spender did not match, so nothing was signed.");
  }
  let current = 0n;
  try {
    if (allowance.actual != null && allowance.actual !== "") {
      current = BigInt(allowance.actual);
    }
  } catch {
    return refuse("The token allowance could not be read, so nothing was signed.");
  }
  try {
    if (current > 0n) {
      await requestWalletTransaction(chatId, wallet.chainId, {
        from: wallet.address,
        to: sell.address,
        data: encodeApprove(spender, 0n),
        value: "0x0",
      });
    }
    await requestWalletTransaction(chatId, wallet.chainId, {
      from: wallet.address,
      to: sell.address,
      data: encodeApprove(spender, sellAmount),
      value: "0x0",
    });
  } catch (error) {
    console.error("swap approval failed:", safeError(error));
    return text(`Swap not sent. The token approval was not signed (${escapeHtml(safeError(error))}). Nothing was broadcast by BLARC.`);
  }
  return text(
    [
      "The swap was not sent.",
      `Sign the approval in your wallet so <code>${escapeHtml(spender)}</code> can spend <b>${escapeHtml(formatUnits(sellAmount, sell.decimals))} ${escapeHtml(sell.label)}</b>.`,
      "That approval is not the swap and does not pay the fee. After it confirms, run /swap again. The swap is sent only when the 1% fee is inside that transaction.",
    ].join("\n"),
  );
}

function buildSwapTx(from, transaction) {
  let gas;
  try {
    if (transaction.gas != null && transaction.gas !== "") {
      gas = (BigInt(transaction.gas) * 120n) / 100n;
    }
  } catch {
    return null;
  }
  const tx = {
    from,
    to: transaction.to,
    data: transaction.data,
    value: `0x${BigInt(transaction.value || "0").toString(16)}`,
  };
  if (gas != null && gas > 0n) {
    tx.gas = `0x${gas.toString(16)}`;
  }
  return tx;
}

function encodeApprove(spender, amount) {
  return `0x095ea7b3${spender.slice(2).toLowerCase().padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;
}

function signedSwapMessage({ wallet, sell, buy, amount, fee, quote, hash }) {
  const buyAmount = formatQuoted(quote.buyAmount, buy.decimals);
  const minBuy = formatQuoted(quote.minBuyAmount, buy.decimals);
  const feeAmount = formatUnits(expectedFeeBaseUnits(BigInt(quote.sellAmount)), sell.decimals);
  const lines = [
    "<b>BLARC swap</b>",
    "Your wallet was asked to sign one swap. BLARC did not sign and does not hold a key.",
    "",
    `Wallet: <code>${escapeHtml(wallet.address)}</code>`,
    `Chain: <code>${escapeHtml(wallet.chainId)}</code>`,
    `Sell: <b>${escapeHtml(amount)} ${escapeHtml(sell.label)}</b>`,
    `Buy: <b>${escapeHtml(buy.label)}</b>${buyAmount ? ` (about ${escapeHtml(buyAmount)})` : ""}`,
    minBuy ? `Minimum bought, after 1% slippage: <b>${escapeHtml(minBuy)}</b>` : "",
    `Fee: <b>1%</b> = <b>${escapeHtml(feeAmount)} ${escapeHtml(sell.label)}</b>`,
    `Fee wallet: <code>${escapeHtml(fee.address)}</code>`,
    "That fee is inside the swap transaction you were asked to sign.",
  ];
  const txHash = String(hash || "");
  if (/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    lines.push(`Transaction: <code>${escapeHtml(txHash)}</code>`);
    const link = explorerTx(fee.chainId, txHash);
    if (link) {
      lines.push(escapeHtml(link));
    }
  } else {
    lines.push("The wallet did not return a transaction hash. If you rejected the prompt, nothing was broadcast.");
  }
  return lines.filter(Boolean).join("\n");
}

function formatQuoted(value, decimals) {
  if (value == null || value === "") {
    return "";
  }
  try {
    return formatUnits(BigInt(value), decimals);
  } catch {
    return "";
  }
}

function formatUnits(value, decimals) {
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const frac = value % scale;
  if (frac === 0n) {
    return whole.toString();
  }
  const fracText = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fracText}`;
}

function explorerTx(chainId, hash) {
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
  return bases[chainId] ? `${bases[chainId]}${hash}` : "";
}

function isHexData(value) {
  return /^0x[0-9a-fA-F]*$/.test(String(value || "")) && String(value).length >= 10;
}

function safeError(error) {
  const message = String(error?.message || "The wallet did not sign.").replace(/\s+/g, " ").trim();
  if (!message || /wc:|sym=|seed|mnemonic|private key|api-key|0x-api/i.test(message)) {
    return "The wallet did not sign.";
  }
  return message.slice(0, 180);
}

const ROBINHOOD_FEE_RECIPIENT = "0x9A47cC17077ea358052FF6233d8aBEe0041E35ed";
const ROBINHOOD_WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const ROBINHOOD_QUOTER_V2 = "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7";
const ROBINHOOD_V3_FEES = [100, 500, 3000, 10000];
const ROBINHOOD_SWAP_SELECTOR = "51e820e7";
const ROBINHOOD_QUOTE_SELECTOR = "c6a5026a";

export function robinhoodFeeSplit(sellAmount) {
  let amount;
  try {
    amount = BigInt(sellAmount);
  } catch {
    return null;
  }
  if (amount <= 0n) {
    return null;
  }
  const fee = expectedFeeBaseUnits(amount);
  if (fee <= 0n || fee >= amount) {
    return null;
  }
  return { fee, swapAmount: amount - fee };
}

export function minimumOut(quotedOut) {
  let out;
  try {
    out = BigInt(quotedOut);
  } catch {
    return 0n;
  }
  if (out <= 0n) {
    return 0n;
  }
  return (out * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;
}

export function chooseV3Tier(quotes) {
  let best = null;
  for (const quote of quotes || []) {
    if (!quote) {
      continue;
    }
    let amountOut;
    try {
      amountOut = BigInt(quote.amountOut);
    } catch {
      continue;
    }
    const fee = Number(quote.fee);
    if (amountOut <= 0n || !Number.isInteger(fee) || fee <= 0) {
      continue;
    }
    if (!best || amountOut > best.amountOut || (amountOut === best.amountOut && fee < best.fee)) {
      best = { fee, amountOut };
    }
  }
  return best;
}

export function robinhoodRouterRefusal(routerAddress, bytecode) {
  if (!isEvmAddress(String(routerAddress || "").trim())) {
    return "Fee cannot be included, swap not sent. The Robinhood fee router is not set.";
  }
  if (!bytecodePresent(bytecode)) {
    return "Fee cannot be included, swap not sent. The Robinhood fee router has no code.";
  }
  return "";
}

export function encodeRobinhoodSwapCall({ tokenIn, tokenOut, poolFee, amountIn, amountOutMinimum, deadline }) {
  return `0x${ROBINHOOD_SWAP_SELECTOR}${encodeAddress(tokenIn)}${encodeAddress(tokenOut)}${encodeWord(poolFee)}${encodeWord(amountIn)}${encodeWord(amountOutMinimum)}${encodeWord(deadline)}`;
}

async function executeRobinhoodSwap({ chatId, wallet, amount, tokenIn, tokenOut, fee }) {
  if (String(fee.address || "").toLowerCase() !== ROBINHOOD_FEE_RECIPIENT.toLowerCase()) {
    return refuse("The Robinhood fee wallet does not match the router recipient.");
  }

  const router = String(process.env.BLARC_ROBINHOOD_ROUTER || "").trim();
  let routerCode = "0x";
  if (isEvmAddress(router)) {
    try {
      routerCode = await ethRpc(ROBINHOOD_CHAIN_ID, "eth_getCode", [router, "latest"]);
    } catch (error) {
      console.error("robinhood router code failed:", error?.code || "rpc");
      return refuse("The Robinhood fee router could not be read.");
    }
  }
  const routerRefusal = robinhoodRouterRefusal(router, routerCode);
  if (routerRefusal) {
    return routerRefusal;
  }
  if (!hasWalletSession(chatId)) {
    return refuse("The WalletConnect session is not active. Run /connect again. Nothing was signed.");
  }

  let sell;
  let buy;
  try {
    sell = await resolveRobinhoodToken(tokenIn);
    buy = await resolveRobinhoodToken(tokenOut);
  } catch (error) {
    console.error("swap token read failed:", error?.code || "read");
    return refuse("The token amount could not be read on this chain, so no transaction was built.");
  }
  if (!sell || !buy) {
    return text(
      "Swap refused. Use a token contract address on this chain, or a known symbol such as ETH, WETH, USDC, USDT, or DAI where that symbol is listed. Nothing was sent.",
    );
  }
  if (sell.address.toLowerCase() === buy.address.toLowerCase()) {
    return text("Choose two different tokens. Nothing was sent.");
  }
  const poolIn = robinhoodPoolToken(sell);
  const poolOut = robinhoodPoolToken(buy);
  if (poolIn.toLowerCase() === poolOut.toLowerCase()) {
    return refuse("Native ETH and WETH are the same asset on this router, so no pool swap was built.");
  }

  const sellAmount = toBaseUnits(amount, sell.decimals);
  if (sellAmount == null) {
    return text("Swap refused. That amount has more decimal places than the token. Nothing was sent.");
  }
  const split = robinhoodFeeSplit(sellAmount);
  if (!split) {
    return refuse("1% of this amount rounds to zero in token units.");
  }

  let best;
  try {
    best = await quoteRobinhoodV3({ tokenIn: poolIn, tokenOut: poolOut, amountIn: split.swapAmount });
  } catch (error) {
    console.error("robinhood quote failed:", error?.code || "quote");
    if (error?.code === "quoter") {
      return refuse("The Robinhood quoter has no code, so no swap was built.");
    }
    return refuse("The swap quote failed, so no transaction was built.");
  }
  if (!best) {
    return refuse("No Uniswap v3 pool quoted this pair.");
  }
  const amountOutMinimum = minimumOut(best.amountOut);
  if (amountOutMinimum <= 0n) {
    return refuse("The quoted output is too small after 1% slippage.");
  }

  const native = sell.address.toLowerCase() === NATIVE;
  if (!native) {
    let current;
    try {
      current = await readErc20Allowance(ROBINHOOD_CHAIN_ID, sell.address, wallet.address, router);
    } catch (error) {
      console.error("robinhood allowance failed:", error?.code || "allowance");
      return refuse("The token allowance could not be read, so nothing was signed.");
    }
    if (current < sellAmount) {
      return requestApproval({
        chatId,
        wallet,
        sell,
        allowance: { spender: router, actual: current.toString() },
        allowanceTarget: router,
        sellAmount,
      });
    }
  }

  let deadline;
  try {
    const block = await ethRpc(ROBINHOOD_CHAIN_ID, "eth_getBlockByNumber", ["latest", false]);
    deadline = BigInt(block.timestamp) + 600n;
  } catch (error) {
    console.error("robinhood block failed:", error?.code || "block");
    return refuse("The swap quote failed, so no transaction was built.");
  }

  const data = encodeRobinhoodSwapCall({
    tokenIn: native ? NATIVE : sell.address,
    tokenOut: buy.address.toLowerCase() === NATIVE ? NATIVE : buy.address,
    poolFee: best.fee,
    amountIn: sellAmount,
    amountOutMinimum,
    deadline,
  });
  const tx = {
    from: wallet.address,
    to: router,
    data,
    value: native ? `0x${sellAmount.toString(16)}` : "0x0",
  };
  try {
    await ethRpc(ROBINHOOD_CHAIN_ID, "eth_call", [tx, "latest"]);
    const estimated = await ethRpc(ROBINHOOD_CHAIN_ID, "eth_estimateGas", [tx, "latest"]);
    const gas = (BigInt(estimated) * 12n) / 10n;
    if (gas > 0n) {
      tx.gas = `0x${gas.toString(16)}`;
    }
  } catch (error) {
    console.error("robinhood simulation failed:", error?.code || "simulation");
    return refuse("The router simulation failed.");
  }

  let hash;
  try {
    hash = await requestWalletTransaction(chatId, wallet.chainId, tx);
  } catch (error) {
    console.error("swap signature failed:", safeError(error));
    return text(`Swap not sent. ${escapeHtml(safeError(error))} Nothing was signed by BLARC.`);
  }
  return text(
    robinhoodSignedMessage({
      wallet,
      sell,
      buy,
      amount,
      fee,
      sellAmount,
      quotedOut: best.amountOut,
      amountOutMinimum,
      router,
      poolFee: best.fee,
      hash,
    }),
  );
}

async function resolveRobinhoodToken(ref) {
  const raw = String(ref || "").trim();
  const lower = raw.toLowerCase();
  if (lower === NATIVE || lower === "0x0000000000000000000000000000000000000000") {
    return { address: NATIVE, decimals: 18, label: "ETH" };
  }
  return resolveToken(ROBINHOOD_CHAIN_ID, raw);
}

function robinhoodPoolToken(token) {
  if (String(token.address).toLowerCase() === NATIVE) {
    return ROBINHOOD_WETH;
  }
  return token.address;
}

async function quoteRobinhoodV3({ tokenIn, tokenOut, amountIn }) {
  const code = await ethRpc(ROBINHOOD_CHAIN_ID, "eth_getCode", [ROBINHOOD_QUOTER_V2, "latest"]);
  if (!bytecodePresent(code)) {
    const error = new Error("quoter");
    error.code = "quoter";
    throw error;
  }
  const quotes = [];
  for (const fee of ROBINHOOD_V3_FEES) {
    const data = `0x${ROBINHOOD_QUOTE_SELECTOR}${encodeAddress(tokenIn)}${encodeAddress(tokenOut)}${encodeWord(amountIn)}${encodeWord(fee)}${encodeWord(0)}`;
    try {
      const result = await ethRpc(ROBINHOOD_CHAIN_ID, "eth_call", [{ to: ROBINHOOD_QUOTER_V2, data }, "latest"]);
      const amountOut = parseQuotedAmount(result);
      if (amountOut != null) {
        quotes.push({ fee, amountOut });
      }
    } catch {
      // This fee tier has no pool. Try the next one.
    }
  }
  return chooseV3Tier(quotes);
}

async function readErc20Allowance(chainId, token, owner, spender) {
  const data = `0xdd62ed3e${encodeAddress(owner)}${encodeAddress(spender)}`;
  const result = await ethRpc(chainId, "eth_call", [{ to: token, data }, "latest"]);
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(result || ""))) {
    const error = new Error("allowance");
    error.code = "allowance";
    throw error;
  }
  return BigInt(result);
}

async function ethRpc(chainId, method, params) {
  const rpc = READ_RPC[chainId];
  if (!rpc) {
    const error = new Error("no rpc");
    error.code = "no-rpc";
    throw error;
  }
  const response = await fetch(rpc, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "blarc-bot",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const error = new Error("rpc http");
    error.code = `http-${response.status}`;
    throw error;
  }
  const body = await response.json();
  if (body.error || body.result == null) {
    const error = new Error("rpc");
    error.code = "rpc";
    throw error;
  }
  return body.result;
}

function robinhoodSignedMessage({ wallet, sell, buy, amount, fee, sellAmount, quotedOut, amountOutMinimum, router, poolFee, hash }) {
  const buyAmount = formatUnits(quotedOut, buy.decimals);
  const minBuy = formatUnits(amountOutMinimum, buy.decimals);
  const feeAmount = formatUnits(robinhoodFeeSplit(sellAmount).fee, sell.decimals);
  const lines = [
    "<b>BLARC swap</b>",
    "Your wallet was asked to sign one Robinhood swap through the BLARC fee router. BLARC did not sign and does not hold a key.",
    "",
    `Wallet: <code>${escapeHtml(wallet.address)}</code>`,
    `Chain: <code>${escapeHtml(wallet.chainId)}</code>`,
    `Router: <code>${escapeHtml(router)}</code>`,
    `Sell: <b>${escapeHtml(amount)} ${escapeHtml(sell.label)}</b>`,
    `Buy: <b>${escapeHtml(buy.label)}</b> (about ${escapeHtml(buyAmount)})`,
    `Minimum bought, after 1% slippage: <b>${escapeHtml(minBuy)}</b>`,
    `Pool fee tier: <code>${escapeHtml(poolFee)}</code>`,
    `Fee: <b>1%</b> = <b>${escapeHtml(feeAmount)} ${escapeHtml(sell.label)}</b>`,
    `Fee wallet: <code>${escapeHtml(fee.address)}</code>`,
    "That fee is inside the router transaction you were asked to sign. There is no fee-less path.",
  ];
  const txHash = String(hash || "");
  if (/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    lines.push(`Transaction: <code>${escapeHtml(txHash)}</code>`);
    const link = explorerTx(fee.chainId, txHash);
    if (link) {
      lines.push(escapeHtml(link));
    }
  } else {
    lines.push("The wallet did not return a transaction hash. If you rejected the prompt, nothing was broadcast.");
  }
  return lines.join("\n");
}

function encodeAddress(addr) {
  return String(addr).slice(2).toLowerCase().padStart(64, "0");
}

function encodeWord(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function parseQuotedAmount(result) {
  const hex = String(result || "");
  if (!/^0x[0-9a-fA-F]{64,}$/.test(hex)) {
    return null;
  }
  try {
    const amount = BigInt(hex.slice(0, 66));
    return amount > 0n ? amount : null;
  } catch {
    return null;
  }
}

function bytecodePresent(code) {
  const value = String(code || "");
  return /^0x[0-9a-fA-F]+$/.test(value) && !/^0x0*$/.test(value);
}
