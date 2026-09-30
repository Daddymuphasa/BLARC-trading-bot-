import assert from "node:assert/strict";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { expectedFeeBaseUnits } from "../src/swap.js";
import {
  SOLANA_FEE_NOT_ADDED,
  SOLANA_FEE_WALLET,
  SOLANA_FEE_ZERO,
  associatedTokenAddress,
  attachFeeInstructions,
  buildFeeInstructions,
  solanaFeeBaseUnits,
  transactionPaysFee,
} from "../src/solanaSwap.js";

const user = new PublicKey("HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk");
const feeWallet = new PublicKey(SOLANA_FEE_WALLET);
const blockhash = new PublicKey(Buffer.alloc(32, 7)).toBase58();
const swapProgram = Keypair.generate().publicKey;
const usdc = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const tokenProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

assert.equal(SOLANA_FEE_WALLET, "X4WBhCgYQFoeugPcevRxgAq7ZWuyu13w646Wh4WY5wL");
assert.equal(solanaFeeBaseUnits(1_000_000_000n), 10_000_000n);
assert.equal(solanaFeeBaseUnits(199n), 1n);
assert.equal(solanaFeeBaseUnits(99n), 0n);
assert.equal(solanaFeeBaseUnits(199n), expectedFeeBaseUnits(199n));
assert.equal(solanaFeeBaseUnits(10n ** 18n), expectedFeeBaseUnits(10n ** 18n));

const zero = buildFeeInstructions({ kind: "sol", user: user.toBase58(), sellAmount: 99n });
assert.equal(zero.ok, false);
assert.equal(zero.userMessage, SOLANA_FEE_ZERO);
assert.equal(zero.instructions, undefined);

const solPlan = buildFeeInstructions({ kind: "sol", user: user.toBase58(), sellAmount: 1_000_000_000n });
assert.equal(solPlan.ok, true);
assert.equal(solPlan.fee, 10_000_000n);
assert.equal(solPlan.swapAmount, 990_000_000n);
assert.equal(solPlan.destination, SOLANA_FEE_WALLET);
assert.equal(solPlan.instructions.length, 1);
assert.equal(solPlan.instructions[0].keys[1].pubkey.toBase58(), SOLANA_FEE_WALLET);
assert.equal(Buffer.from(solPlan.instructions[0].data).readBigUInt64LE(4), 10_000_000n);

const huge = buildFeeInstructions({
  kind: "sol",
  user: user.toBase58(),
  sellAmount: 9007199254740993n * 100n,
});
assert.equal(huge.ok, true);
assert.equal(Buffer.from(huge.instructions[0].data).readBigUInt64LE(4), solanaFeeBaseUnits(9007199254740993n * 100n));

const splPlan = buildFeeInstructions({
  kind: "spl",
  user: user.toBase58(),
  mint: usdc.toBase58(),
  tokenProgram: tokenProgram.toBase58(),
  decimals: 6,
  sellAmount: 1_000_000n,
});
assert.equal(splPlan.ok, true);
assert.equal(splPlan.fee, 10_000n);
assert.equal(splPlan.swapAmount, 990_000n);
const ata = associatedTokenAddress(feeWallet, usdc, tokenProgram);
assert.equal(splPlan.destination, ata.toBase58());
assert.notEqual(splPlan.destination, SOLANA_FEE_WALLET);
assert.equal(splPlan.instructions[0].data[0], 1);
assert.equal(splPlan.instructions[0].keys[2].pubkey.toBase58(), SOLANA_FEE_WALLET);
const transfer = splPlan.instructions[1];
assert.equal(transfer.data[0], 12);
assert.equal(Buffer.from(transfer.data).readBigUInt64LE(1), 10_000n);
assert.equal(transfer.keys[2].pubkey.toBase58(), ata.toBase58());
assert.equal(transfer.keys[3].pubkey.toBase58(), user.toBase58());
assert.equal(transfer.keys[3].isSigner, true);

function swapInstruction() {
  return new TransactionInstruction({
    programId: swapProgram,
    keys: [{ pubkey: user, isSigner: true, isWritable: true }],
    data: Buffer.from([9, 9, 9]),
  });
}

function computeInstruction() {
  return new TransactionInstruction({
    programId: new PublicKey("ComputeBudget111111111111111111111111111111"),
    keys: [],
    data: Buffer.from([2, 1, 0, 0, 0]),
  });
}

function legacySwap() {
  const tx = new Transaction({ feePayer: user, recentBlockhash: blockhash });
  tx.add(computeInstruction(), swapInstruction());
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

const bare = Transaction.from(Buffer.from(legacySwap(), "base64"));
assert.equal(transactionPaysFee(bare, solPlan), false);

const attached = attachFeeInstructions(legacySwap(), solPlan);
assert.equal(attached.ok, true);
assert.equal(typeof attached.transaction, "string");
const paid = Transaction.from(Buffer.from(attached.transaction, "base64"));
assert.equal(transactionPaysFee(paid, solPlan), true);
assert.equal(paid.instructions[0].programId.toBase58(), "ComputeBudget111111111111111111111111111111");
assert.equal(paid.instructions[1].programId.equals(SystemProgram.programId), true);
assert.equal(paid.instructions[2].programId.toBase58(), swapProgram.toBase58());
assert.equal(paid.feePayer.toBase58(), user.toBase58());

const misdirected = {
  ...solPlan,
  instructions: [
    SystemProgram.transfer({
      fromPubkey: user,
      toPubkey: user,
      lamports: solPlan.fee,
    }),
  ],
};
const rejected = attachFeeInstructions(legacySwap(), misdirected);
assert.equal(rejected.ok, false);
assert.equal(rejected.userMessage, SOLANA_FEE_NOT_ADDED);
assert.equal(rejected.transaction, undefined);

const garbage = attachFeeInstructions("not-a-transaction", solPlan);
assert.equal(garbage.ok, false);
assert.equal(garbage.userMessage, SOLANA_FEE_NOT_ADDED);

const message = new TransactionMessage({
  payerKey: user,
  recentBlockhash: blockhash,
  instructions: [computeInstruction(), swapInstruction()],
}).compileToV0Message();
const versioned = Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
const vAttached = attachFeeInstructions(versioned, splPlan);
assert.equal(vAttached.ok, true);
const vTx = VersionedTransaction.deserialize(Buffer.from(vAttached.transaction, "base64"));
const decoded = TransactionMessage.decompile(vTx.message);
assert.equal(transactionPaysFee(decoded, splPlan), true);
assert.equal(decoded.instructions.at(-1).programId.toBase58(), swapProgram.toBase58());
assert.equal(decoded.instructions.some((ix) => ix.data[0] === 1 && ix.keys[2].pubkey.equals(feeWallet)), true);

const missingTables = attachFeeInstructions(versioned, solPlan, []);
assert.equal(missingTables.ok, true);

console.log("solana fee checks ok");
