// Offline checks for the Circle App Kit integration: fee math, approval guards, Arc swap pairs.
import assert from "node:assert/strict";
import { ARC_SWAP_TOKENS, arcKitInternals, bridgeChain, bridgeDestinations, bridgeFeeFor, isArcKitPair, toUnits } from "../src/arcKit.js";

const { bridgeGuard, arcSwapGuard, kitFeeOk, developerFeeOk } = arcKitInternals;

// 1% fee in USDC base units, on top of the bridge amount.
const ten = bridgeFeeFor("10");
assert.equal(ten.amountUnits, 10_000_000n);
assert.equal(ten.feeUnits, 100_000n);
assert.equal(ten.fee, "0.1");
assert.equal(bridgeFeeFor("0.00001"), null);
assert.equal(bridgeFeeFor("abc"), null);

// Bridge Kit must report exactly one kit fee equal to our 1%. Otherwise refuse.
assert.equal(kitFeeOk([{ type: "kit", token: "USDC", amount: "0.1" }], 100_000n), true);
assert.equal(kitFeeOk([{ type: "kit", token: "USDC", amount: "0.05" }], 100_000n), false);
assert.equal(kitFeeOk([], 100_000n), false);

// Arc is a destination for every source; destinations never include the source.
for (const id of [8453, 1, 42161, 10, 137]) {
  const dests = bridgeDestinations(id).map((c) => c.id);
  assert.ok(dests.includes(5042), `Arc missing as destination from ${id}`);
  assert.ok(!dests.includes(id));
}

// Approval guard: Base USDC approve to the kit bridge contract for amount + fee only.
const base = bridgeChain(8453);
const guard = bridgeGuard({ source: base, maxApproval: 1_010_000n });
const spender = "b3fa262d0fb521cc93be83d87b322b8a23daf3f0";
const approve = (amount) => `0x39509351000000000000000000000000${spender}${amount.toString(16).padStart(64, "0")}`;
const usdcBase = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
guard.tx(8453, { to: usdcBase, data: approve(1_010_000n) });
assert.throws(() => guard.tx(8453, { to: usdcBase, data: approve(2_000_000n) }));
assert.throws(() => guard.tx(1, { to: usdcBase, data: approve(1_010_000n) }));
assert.throws(() => guard.tx(8453, { to: "0x000000000000000000000000000000000000dEaD", data: "0x" }));
assert.throws(() => guard.tx(8453, { to: `0x${spender}`, data: "0x", value: "0x1" }));
guard.tx(8453, { to: `0x${spender}`, data: "0x1234" });
assert.throws(() => guard.typed(8453, {}));

// Arc swap pairs: only USDC, EURC, cirBTC.
assert.equal(isArcKitPair("USDC", "EURC"), true);
assert.equal(isArcKitPair("usdc", "cirbtc"), true);
assert.equal(isArcKitPair("USDC", "USDC"), false);
assert.equal(isArcKitPair("USDC", "WETH"), false);

// Arc swap permit guard and developer fee check.
const usdc = ARC_SWAP_TOKENS.USDC;
const swapGuard = arcSwapGuard({ sell: usdc, sellUnits: 1_000_000n });
const permit = (spenderAddr, value, chainId = 5042) => ({
  primaryType: "Permit",
  domain: { chainId, verifyingContract: usdc.address },
  message: { spender: spenderAddr, value: String(value) },
});
swapGuard.typed(5042, permit("0x7fb8c7260b63934d8da38af902f87ae6e284a845", 1_000_000n));
assert.throws(() => swapGuard.typed(5042, permit("0x7fb8c7260b63934d8da38af902f87ae6e284a845", 5_000_000n)));
assert.throws(() => swapGuard.typed(5042, permit("0x000000000000000000000000000000000000dEaD", 1n)));
assert.throws(() => swapGuard.typed(5042, permit("0x7fb8c7260b63934d8da38af902f87ae6e284a845", 1n, 1)));
const feeAddress = "0x9A47cC17077ea358052FF6233d8aBEe0041E35ed";
assert.equal(developerFeeOk([{ type: "developer", amount: "0.01", recipientAddress: feeAddress }], { sell: usdc, sellUnits: toUnits("1", 6), feeAddress }), true);
assert.equal(developerFeeOk([{ type: "developer", amount: "0.01", recipientAddress: "0x000000000000000000000000000000000000dEaD" }], { sell: usdc, sellUnits: toUnits("1", 6), feeAddress }), false);
assert.equal(developerFeeOk([], { sell: usdc, sellUnits: toUnits("1", 6), feeAddress }), false);

console.log("arc kit checks passed");
