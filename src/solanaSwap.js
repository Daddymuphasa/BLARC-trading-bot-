import {
  AddressLookupTableAccount,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { solanaRpcUrl } from "./config.js";
import { FEE_BPS, isSolanaAddress, solanaSignBlocker, requestSolanaTransaction } from "./wallet.js";

export const SOLANA_FEE_WALLET = "X4WBhCgYQFoeugPcevRxgAq7ZWuyu13w646Wh4WY5wL";
export const SOLANA_FEE_NOT_ADDED =
  "Fee cannot be included, swap not sent. The 1% fee transfer could not be added to the Solana transaction, so nothing was signed.";
export const SOLANA_FEE_ZERO =
  "Fee cannot be included, swap not sent. 1% of this amount rounds to zero in token units.";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey("ComputeBudget111111111111111111111111111111");
const JUPITER_QUOTE_URL = "https://api.jup.ag/swap/v1/quote";
const JUPITER_SWAP_URL = "https://api.jup.ag/swap/v1/swap";
const SLIPPAGE_BPS = 100;
const U64_MAX = 2n ** 64n - 1n;

const KNOWN = {
  SOL: { mint: WSOL_MINT, decimals: 9, native: true, program: TOKEN_PROGRAM_ID.toBase58() },
  USDC: {
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6,
    native: false,
    program: TOKEN_PROGRAM_ID.toBase58(),
  },
  USDT: {
    mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    decimals: 6,
    native: false,
    program: TOKEN_PROGRAM_ID.toBase58(),
  },
};

const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]);

export function solanaFeeBaseUnits(sellAmount) {
  return (BigInt(sellAmount) * BigInt(FEE_BPS)) / 10000n;
}

export function associatedTokenAddress(owner, mint, tokenProgram) {
  const [address] = PublicKey.findProgramAddressSync(
    [publicKey(owner).toBuffer(), publicKey(tokenProgram).toBuffer(), publicKey(mint).toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

export function buildFeeInstructions({ kind, user, mint, tokenProgram, decimals, sellAmount }) {
  let amount;
  try {
    amount = BigInt(sellAmount);
  } catch {
    return { ok: false, userMessage: refuse("The sell amount could not be read, so no transaction was built.") };
  }
  const fee = solanaFeeBaseUnits(amount);
  if (fee <= 0n) {
    return { ok: false, userMessage: SOLANA_FEE_ZERO };
  }
  if (fee >= amount) {
    return { ok: false, userMessage: refuse("The 1% fee leaves nothing to swap, so no transaction was built.") };
  }
  if (fee > U64_MAX || amount - fee > U64_MAX) {
    return { ok: false, userMessage: refuse("The fee amount does not fit in a Solana transfer, so nothing was signed.") };
  }
  let userKey;
  let feeKey;
  try {
    userKey = new PublicKey(user);
    feeKey = new PublicKey(SOLANA_FEE_WALLET);
  } catch {
    return { ok: false, userMessage: refuse("The connected account is not a Solana address, so no transaction was built.") };
  }
  if (!feeKey.equals(new PublicKey(SOLANA_FEE_WALLET)) || userKey.equals(feeKey)) {
    return { ok: false, userMessage: refuse("The Solana fee wallet is not the required public address, so nothing was signed.") };
  }
  if (kind === "sol") {
    const transfer = SystemProgram.transfer({
      fromPubkey: userKey,
      toPubkey: feeKey,
      lamports: fee,
    });
    return {
      ok: true,
      kind: "sol",
      user,
      fee,
      swapAmount: amount - fee,
      destination: feeKey.toBase58(),
      instructions: [transfer],
    };
  }
  if (kind !== "spl") {
    return { ok: false, userMessage: SOLANA_FEE_NOT_ADDED };
  }
  let mintKey;
  let programKey;
  try {
    mintKey = new PublicKey(mint);
    programKey = new PublicKey(tokenProgram);
  } catch {
    return { ok: false, userMessage: refuse("The fee token account could not be built, so nothing was signed.") };
  }
  if (!TOKEN_PROGRAMS.has(programKey.toBase58())) {
    return { ok: false, userMessage: refuse("The fee token program is not supported, so nothing was signed.") };
  }
  const decimalsNumber = Number(decimals);
  if (!Number.isInteger(decimalsNumber) || decimalsNumber < 0 || decimalsNumber > 9) {
    return { ok: false, userMessage: refuse("The token decimals could not be read, so no transaction was built.") };
  }
  const source = associatedTokenAddress(userKey, mintKey, programKey);
  const destination = associatedTokenAddress(feeKey, mintKey, programKey);
  const createDestination = new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: userKey, isSigner: true, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: feeKey, isSigner: false, isWritable: false },
      { pubkey: mintKey, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: programKey, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(fee, 1);
  data.writeUInt8(decimalsNumber, 9);
  const transfer = new TransactionInstruction({
    programId: programKey,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mintKey, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: userKey, isSigner: true, isWritable: false },
    ],
    data,
  });
  return {
    ok: true,
    kind: "spl",
    user,
    mint: mintKey.toBase58(),
    tokenProgram: programKey.toBase58(),
    decimals: decimalsNumber,
    fee,
    swapAmount: amount - fee,
    destination: destination.toBase58(),
    instructions: [createDestination, transfer],
  };
}

export function transactionPaysFee(message, plan) {
  if (!plan?.ok || !Array.isArray(message?.instructions)) {
    return false;
  }
  let feeKey;
  let userKey;
  try {
    feeKey = new PublicKey(SOLANA_FEE_WALLET);
    userKey = new PublicKey(plan.user);
  } catch {
    return false;
  }
  const fee = BigInt(plan.fee);
  if (fee <= 0n) {
    return false;
  }
  if (plan.kind === "sol") {
    if (plan.destination !== feeKey.toBase58()) {
      return false;
    }
    return message.instructions.some((ix) => systemTransferMatches(ix, userKey, feeKey, fee));
  }
  if (plan.kind !== "spl") {
    return false;
  }
  let mintKey;
  let programKey;
  let destination;
  try {
    mintKey = new PublicKey(plan.mint);
    programKey = new PublicKey(plan.tokenProgram);
    destination = associatedTokenAddress(feeKey, mintKey, programKey);
  } catch {
    return false;
  }
  if (plan.destination !== destination.toBase58() || !TOKEN_PROGRAMS.has(programKey.toBase58())) {
    return false;
  }
  return message.instructions.some((ix) =>
    tokenTransferMatches(ix, {
      programKey,
      sourceOwner: userKey,
      mintKey,
      destination,
      amount: fee,
      decimals: plan.decimals,
    }),
  );
}

export function attachFeeInstructions(serializedBase64, plan, addressLookupTableAccounts = []) {
  if (!plan?.ok || !Array.isArray(plan.instructions) || plan.instructions.length === 0) {
    return { ok: false, userMessage: SOLANA_FEE_NOT_ADDED };
  }
  let bytes;
  try {
    bytes = Buffer.from(String(serializedBase64 || ""), "base64");
  } catch {
    return { ok: false, userMessage: SOLANA_FEE_NOT_ADDED };
  }
  if (bytes.length < 1) {
    return { ok: false, userMessage: SOLANA_FEE_NOT_ADDED };
  }
  const version = serializedMessageVersion(bytes);
  if (version === "legacy") {
    return attachLegacy(bytes, plan);
  }
  if (version === 0) {
    return attachVersioned(bytes, plan, addressLookupTableAccounts);
  }
  return { ok: false, userMessage: SOLANA_FEE_NOT_ADDED };
}

export async function executeSolanaSwap({ chatId, wallet, amount, tokenIn, tokenOut, fee }) {
  if (String(fee?.address || "") !== SOLANA_FEE_WALLET) {
    return refuse("The Solana fee wallet is not the required public address, so nothing was signed.");
  }
  const user = String(wallet?.address || "");
  if (!isSolanaAddress(user) || !isPublicKey(user)) {
    return refuse("The connected account is not a Solana address, so no transaction was built.");
  }
  const blocker = await solanaSignBlocker(chatId, user);
  if (blocker) {
    return refuse(blocker);
  }

  let sell;
  let buy;
  try {
    sell = await resolveSolanaToken(tokenIn);
    buy = await resolveSolanaToken(tokenOut);
  } catch (error) {
    console.error("solana token read failed:", error?.code || "read");
    if (error?.code === "no-rpc") {
      return refuse("The Solana RPC is not set, so the fee account could not be built.");
    }
    return refuse("The token amount could not be read, so no transaction was built.");
  }
  if (!sell || !buy) {
    return "Swap refused. Use SOL, USDC, USDT, or a Solana mint address. Nothing was sent.";
  }
  if (sell.native && buy.native) {
    return "Choose two different tokens. Nothing was sent.";
  }
  if (!sell.native && !buy.native && sell.mint === buy.mint) {
    return "Choose two different tokens. Nothing was sent.";
  }

  const sellAmount = toBaseUnits(amount, sell.decimals);
  if (sellAmount == null) {
    return "Swap refused. That amount has more decimal places than the token. Nothing was sent.";
  }
  const plan = buildFeeInstructions({
    kind: sell.native ? "sol" : "spl",
    user,
    mint: sell.mint,
    tokenProgram: sell.program,
    decimals: sell.decimals,
    sellAmount,
  });
  if (!plan.ok) {
    return plan.userMessage;
  }

  let quote;
  try {
    quote = await fetchJupiterQuote({
      inputMint: sell.mint,
      outputMint: buy.mint,
      amount: plan.swapAmount,
    });
  } catch (error) {
    console.error("solana quote failed:", error?.code || "quote");
    return refuse("The Solana swap quote failed, so no transaction was built.");
  }
  const quoteCheck = validateJupiterQuote(quote, { inputMint: sell.mint, outputMint: buy.mint, swapAmount: plan.swapAmount });
  if (!quoteCheck.ok) {
    console.error("solana quote rejected:", quoteCheck.reason);
    return refuse("The quote did not match the sell amount after the 1% fee, so nothing was signed.");
  }

  let swapTransaction;
  try {
    swapTransaction = await fetchJupiterSwap({ quote, user });
  } catch (error) {
    console.error("solana swap build failed:", error?.code || "swap");
    return refuse("The Solana swap transaction could not be built, so nothing was signed.");
  }

  let lookupTables = [];
  if (serializedMessageVersion(Buffer.from(swapTransaction, "base64")) === 0) {
    try {
      lookupTables = await loadLookupTables(swapTransaction);
    } catch (error) {
      console.error("solana lookup tables failed:", error?.code || "alt");
      if (error?.code === "no-rpc") {
        return refuse("The Solana RPC is not set, so the 1% fee could not be added to the versioned swap. Nothing was signed.");
      }
      return refuse("The Solana address lookup tables could not be read, so the 1% fee could not be added. Nothing was signed.");
    }
  }

  const attached = attachFeeInstructions(swapTransaction, plan, lookupTables);
  if (!attached.ok || !attached.transaction) {
    return attached.userMessage || SOLANA_FEE_NOT_ADDED;
  }
  if (!serializedTransactionPaysFee(attached.transaction, plan, lookupTables)) {
    return SOLANA_FEE_NOT_ADDED;
  }

  let result;
  try {
    result = await requestSolanaTransaction(chatId, user, attached.transaction);
  } catch (error) {
    console.error("solana swap signature failed:", safeError(error));
    return `Swap not sent. ${escapeHtml(safeError(error))} Nothing was signed by BLARC.`;
  }
  return signedSolanaMessage({
    wallet,
    sell,
    buy,
    amount,
    fee,
    plan,
    quote,
    signature: solanaSignature(result),
  });
}

function attachLegacy(bytes, plan) {
  let tx;
  try {
    tx = Transaction.from(bytes);
  } catch {
    return { ok: false, userMessage: SOLANA_FEE_NOT_ADDED };
  }
  if (!tx.feePayer || !tx.recentBlockhash || tx.instructions.length === 0) {
    return { ok: false, userMessage: SOLANA_FEE_NOT_ADDED };
  }
  if (!tx.feePayer.equals(new PublicKey(plan.user))) {
    return { ok: false, userMessage: refuse("The swap transaction fee payer is not the connected wallet, so nothing was signed.") };
  }
  const original = tx.instructions.map((ix) => ix.programId.toBase58());
  const index = insertIndex(tx.instructions);
  tx.instructions.splice(index, 0, ...plan.instructions);
  if (tx.instructions.length !== original.length + plan.instructions.length) {
    return { ok: false, userMessage: SOLANA_FEE_NOT_ADDED };
  }
  if (!transactionPaysFee(tx, plan)) {
    return { ok: false, userMessage: SOLANA_FEE_NOT_ADDED };
  }
  let serialized;
  try {
    serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  } catch {
    return { ok: false, userMessage: SOLANA_FEE_NOT_ADDED };
  }
  if (!serializedTransactionPaysFee(serialized, plan, [])) {
    return { ok: false, userMessage: SOLANA_FEE_NOT_ADDED };
  }
  return { ok: true, transaction: serialized };
}

function attachVersioned(bytes, plan, addressLookupTableAccounts) {
  let vtx;
  try {
    vtx = VersionedTransaction.deserialize(bytes);
  } catch {
    return { ok: false, userMessage: SOLANA_FEE_NOT_ADDED };
  }
  const lookups = vtx.message.addressTableLookups || [];
  const tables = Array.isArray(addressLookupTableAccounts) ? addressLookupTableAccounts : [];
  if (lookups.length !== tables.length) {
    return { ok: false, userMessage: SOLANA_FEE_NOT_ADDED };
  }
  let decompiled;
  try {
    decompiled = TransactionMessage.decompile(vtx.message, { addressLookupTableAccounts: tables });
  } catch {
    return { ok: false, userMessage: SOLANA_FEE_NOT_ADDED };
  }
  if (!decompiled.payerKey.equals(new PublicKey(plan.user)) || decompiled.instructions.length === 0) {
    return { ok: false, userMessage: refuse("The swap transaction fee payer is not the connected wallet, so nothing was signed.") };
  }
  const originalCount = decompiled.instructions.length;
  const index = insertIndex(decompiled.instructions);
  decompiled.instructions.splice(index, 0, ...plan.instructions);
  if (decompiled.instructions.length !== originalCount + plan.instructions.length || !transactionPaysFee(decompiled, plan)) {
    return { ok: false, userMessage: SOLANA_FEE_NOT_ADDED };
  }
  let compiled;
  try {
    compiled = decompiled.compileToV0Message(tables);
  } catch {
    return { ok: false, userMessage: SOLANA_FEE_NOT_ADDED };
  }
  const out = new VersionedTransaction(compiled);
  let serialized;
  try {
    serialized = Buffer.from(out.serialize()).toString("base64");
  } catch {
    return { ok: false, userMessage: SOLANA_FEE_NOT_ADDED };
  }
  if (!serializedTransactionPaysFee(serialized, plan, tables)) {
    return { ok: false, userMessage: SOLANA_FEE_NOT_ADDED };
  }
  return { ok: true, transaction: serialized };
}

function serializedTransactionPaysFee(serialized, plan, tables) {
  const bytes = Buffer.from(serialized, "base64");
  const version = serializedMessageVersion(bytes);
  if (version === "legacy") {
    try {
      return transactionPaysFee(Transaction.from(bytes), plan);
    } catch {
      return false;
    }
  }
  if (version !== 0) {
    return false;
  }
  try {
    const vtx = VersionedTransaction.deserialize(bytes);
    const message = TransactionMessage.decompile(vtx.message, { addressLookupTableAccounts: tables || [] });
    return transactionPaysFee(message, plan);
  } catch {
    return false;
  }
}

function systemTransferMatches(ix, userKey, feeKey, fee) {
  if (!ix.programId.equals(SystemProgram.programId) || !ix.data || ix.data.length < 12 || ix.keys.length < 2) {
    return false;
  }
  const data = Buffer.from(ix.data);
  if (data.readUInt32LE(0) !== 2) {
    return false;
  }
  return (
    data.readBigUInt64LE(4) === fee &&
    ix.keys[0].pubkey.equals(userKey) &&
    ix.keys[0].isSigner &&
    ix.keys[1].pubkey.equals(feeKey)
  );
}

function tokenTransferMatches(ix, { programKey, sourceOwner, mintKey, destination, amount, decimals }) {
  if (!ix.programId.equals(programKey) || !ix.data || ix.data.length < 10 || ix.keys.length < 4) {
    return false;
  }
  const data = Buffer.from(ix.data);
  if (data.readUInt8(0) !== 12 || data.readUInt8(9) !== decimals) {
    return false;
  }
  return (
    data.readBigUInt64LE(1) === amount &&
    ix.keys[1].pubkey.equals(mintKey) &&
    ix.keys[2].pubkey.equals(destination) &&
    ix.keys[3].pubkey.equals(sourceOwner) &&
    ix.keys[3].isSigner
  );
}

function insertIndex(instructions) {
  let index = 0;
  while (index < instructions.length && instructions[index].programId.equals(COMPUTE_BUDGET_PROGRAM_ID)) {
    index += 1;
  }
  return index;
}

function serializedMessageVersion(buf) {
  const sigs = readShortVec(buf, 0);
  if (!sigs) {
    return null;
  }
  const offset = sigs.cursor + sigs.value * 64;
  if (offset < 0 || offset >= buf.length) {
    return null;
  }
  const prefix = buf[offset];
  if ((prefix & 0x80) === 0) {
    return "legacy";
  }
  return prefix & 0x7f;
}

function readShortVec(buf, offset) {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  for (let i = 0; i < 3; i += 1) {
    if (cursor >= buf.length) {
      return null;
    }
    const byte = buf[cursor];
    cursor += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value, cursor };
    }
    shift += 7;
  }
  return null;
}

async function resolveSolanaToken(ref) {
  const raw = String(ref || "").trim();
  const known = KNOWN[raw.toUpperCase()];
  if (known && !isPublicKey(raw)) {
    return { ...known, label: raw.toUpperCase() };
  }
  if (!isPublicKey(raw)) {
    return null;
  }
  const mint = new PublicKey(raw);
  if (mint.equals(new PublicKey(WSOL_MINT))) {
    return { mint: mint.toBase58(), decimals: 9, native: false, program: TOKEN_PROGRAM_ID.toBase58(), label: mint.toBase58() };
  }
  const account = await rpcCall("getAccountInfo", [mint.toBase58(), { encoding: "base64" }]);
  const value = account?.value;
  if (!value?.data?.[0] || !value.owner) {
    const error = new Error("mint");
    error.code = "mint";
    throw error;
  }
  if (!TOKEN_PROGRAMS.has(value.owner)) {
    const error = new Error("program");
    error.code = "program";
    throw error;
  }
  const data = Buffer.from(value.data[0], "base64");
  if (data.length < 45) {
    const error = new Error("mint");
    error.code = "mint";
    throw error;
  }
  const decimals = data[44];
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9) {
    const error = new Error("decimals");
    error.code = "decimals";
    throw error;
  }
  return { mint: mint.toBase58(), decimals, native: false, program: value.owner, label: mint.toBase58() };
}

async function loadLookupTables(serialized) {
  const vtx = VersionedTransaction.deserialize(Buffer.from(serialized, "base64"));
  const lookups = vtx.message.addressTableLookups || [];
  if (lookups.length === 0) {
    return [];
  }
  if (!solanaRpcUrl()) {
    const error = new Error("no rpc");
    error.code = "no-rpc";
    throw error;
  }
  const tables = [];
  for (const lookup of lookups) {
    const key = lookup.accountKey.toBase58();
    const account = await rpcCall("getAccountInfo", [key, { encoding: "base64" }]);
    if (!account?.value?.data?.[0]) {
      const error = new Error("alt");
      error.code = "alt";
      throw error;
    }
    const data = Buffer.from(account.value.data[0], "base64");
    tables.push(
      new AddressLookupTableAccount({
        key: new PublicKey(key),
        state: AddressLookupTableAccount.deserialize(data),
      }),
    );
  }
  return tables;
}

async function rpcCall(method, params) {
  const url = solanaRpcUrl();
  if (!url) {
    const error = new Error("no rpc");
    error.code = "no-rpc";
    throw error;
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) {
    const error = new Error("rpc http");
    error.code = "rpc";
    throw error;
  }
  const body = await response.json();
  if (body.error) {
    const error = new Error("rpc");
    error.code = "rpc";
    throw error;
  }
  return body.result;
}

async function fetchJupiterQuote({ inputMint, outputMint, amount }) {
  const url = new URL(JUPITER_QUOTE_URL);
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", amount.toString());
  url.searchParams.set("slippageBps", String(SLIPPAGE_BPS));
  url.searchParams.set("asLegacyTransaction", "true");
  url.searchParams.set("restrictIntermediateTokens", "true");
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const error = new Error("quote http");
    error.code = `http-${response.status}`;
    throw error;
  }
  return response.json();
}

function validateJupiterQuote(quote, { inputMint, outputMint, swapAmount }) {
  if (!quote || typeof quote !== "object") {
    return { ok: false, reason: "quote" };
  }
  if (quote.inputMint !== inputMint || quote.outputMint !== outputMint) {
    return { ok: false, reason: "mint" };
  }
  try {
    if (BigInt(quote.inAmount) !== BigInt(swapAmount)) {
      return { ok: false, reason: "amount" };
    }
  } catch {
    return { ok: false, reason: "amount" };
  }
  if (quote.platformFee && quote.platformFee.amount != null && BigInt(quote.platformFee.amount) !== 0n) {
    return { ok: false, reason: "platform-fee" };
  }
  return { ok: true };
}

async function fetchJupiterSwap({ quote, user }) {
  const response = await fetch(JUPITER_SWAP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: user,
      wrapAndUnwrapSol: true,
      asLegacyTransaction: true,
      dynamicComputeUnitLimit: false,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const error = new Error("swap http");
    error.code = `http-${response.status}`;
    throw error;
  }
  const body = await response.json();
  if (!body || typeof body.swapTransaction !== "string" || body.swapTransaction.length < 16) {
    const error = new Error("swap tx");
    error.code = "swap-tx";
    throw error;
  }
  return body.swapTransaction;
}

function signedSolanaMessage({ wallet, sell, buy, amount, fee, plan, quote, signature }) {
  const feeAmount = formatUnits(plan.fee, sell.decimals);
  const buyAmount = formatQuoted(quote.outAmount, buy.decimals);
  const lines = [
    "<b>BLARC swap</b>",
    "Your wallet was asked to sign one Solana swap. BLARC did not sign and does not hold a key.",
    "",
    `Wallet: <code>${escapeHtml(wallet.address)}</code>`,
    "Chain: <code>Solana</code>",
    `Sell: <b>${escapeHtml(amount)} ${escapeHtml(sell.label || (sell.native ? "SOL" : sell.mint))}</b>`,
    `Buy: <b>${escapeHtml(buy.label || (buy.native ? "SOL" : buy.mint))}</b>${buyAmount ? ` (about ${escapeHtml(buyAmount)})` : ""}`,
    `Fee: <b>1%</b> = <b>${escapeHtml(feeAmount)} ${escapeHtml(sell.label || (sell.native ? "SOL" : "token"))}</b>`,
    `Fee wallet: <code>${escapeHtml(fee.address)}</code>`,
    plan.kind === "sol"
      ? "That 1% is a SOL transfer inside the swap transaction you were asked to sign. There is no fee-less path."
      : "That 1% is a token transfer inside the swap transaction you were asked to sign. There is no fee-less path.",
  ];
  if (/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(signature)) {
    lines.push(`Transaction: <code>${escapeHtml(signature)}</code>`);
    lines.push(escapeHtml(`https://solscan.io/tx/${signature}`));
  } else {
    lines.push("The wallet did not return a transaction signature. If you rejected the prompt, nothing was broadcast.");
  }
  return lines.filter(Boolean).join("\n");
}

function solanaSignature(result) {
  if (typeof result === "string") {
    return result;
  }
  if (result && typeof result.signature === "string") {
    return result.signature;
  }
  return "";
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

function publicKey(value) {
  return value instanceof PublicKey ? value : new PublicKey(value);
}

function isPublicKey(value) {
  try {
    const key = new PublicKey(value);
    return Boolean(key);
  } catch {
    return false;
  }
}

function refuse(detail) {
  return `Fee cannot be included, swap not sent. ${detail}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function safeError(error) {
  const message = String(error?.message || "The wallet did not sign.")
    .replace(/\s+/g, " ")
    .replace(/[A-Za-z0-9+/=]{40,}/g, "[redacted]")
    .trim();
  if (!message || /wc:|sym=|seed|mnemonic|private key|api-key|0x-api/i.test(message)) {
    return "The wallet did not sign.";
  }
  return message.slice(0, 180);
}

