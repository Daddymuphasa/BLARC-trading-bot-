import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { readFileSync } from "node:fs";
process.env.BLARC_FEE_ADDRESS = "0x9a47cc17077ea358052ff6233d8abee0041e35ed";
process.env.BLARC_FEE_ADDRESS_ROBINHOOD = "0x729241d4d22cb8bD54E9210D1FE1e16b74A2a784";
process.env.BLARC_FEE_ADDRESS_ARC = "0x9A47cC17077ea358052FF6233d8aBEe0041E35ed";
delete process.env.BLARC_ROBINHOOD_ROUTER;

const {
  chooseV3Tier,
  encodeRobinhoodSwapCall,
  executeSwap,
  minimumOut,
  robinhoodFeeSplit,
  robinhoodRouterRefusal,
} = await import("../src/swap.js");

const sell = 1_000_000n;
const split = robinhoodFeeSplit(sell);
assert.ok(split);
assert.equal(split.fee, 10_000n);
assert.equal(split.swapAmount, 990_000n);
assert.equal(split.fee + split.swapAmount, sell);
assert.equal(split.fee * 100n, sell);

const oneEth = 10n ** 18n;
const eth = robinhoodFeeSplit(oneEth);
assert.ok(eth);
assert.equal(eth.fee, oneEth / 100n);
assert.equal(eth.swapAmount, (oneEth * 99n) / 100n);
assert.equal(robinhoodFeeSplit(99n), null);
assert.equal(robinhoodFeeSplit(0n), null);

const missing = robinhoodRouterRefusal("", "0x");
assert.equal(missing.startsWith("Swap could not be prepared."), true);
assert.equal(missing.includes("not set"), true);

const sample = "0x0000000000000000000000000000000000000001";
const emptyCode = robinhoodRouterRefusal(sample, "0x");
assert.equal(emptyCode.startsWith("Swap could not be prepared."), true);
assert.equal(emptyCode.includes("no code"), true);
assert.equal(robinhoodRouterRefusal(sample, "0x0"), emptyCode);
assert.equal(robinhoodRouterRefusal(sample, "0x60"), "");

assert.equal(minimumOut(10_000n), 9_900n);
const best = chooseV3Tier([
  { fee: 100, amountOut: 10n },
  { fee: 500, amountOut: 0n },
  { fee: 3000, amountOut: 50n },
  { fee: 10000, amountOut: 50n },
]);
assert.deepEqual(best, { fee: 3000, amountOut: 50n });
assert.equal(chooseV3Tier([]), null);

const data = encodeRobinhoodSwapCall({
  tokenIn: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  tokenOut: sample,
  poolFee: 3000,
  amountIn: sell,
  amountOutMinimum: 99n,
  deadline: 10n,
});
const signature = "swapExactInputSingle(address,address,uint24,uint256,uint256,uint256)";
const selector = Buffer.from(keccak_256(new TextEncoder().encode(signature))).toString("hex").slice(0, 8);
assert.equal(data.slice(2, 10), selector);
const words = data.slice(10).match(/.{64}/g);
assert.equal(words.length, 6);
assert.equal(BigInt(`0x${words[2]}`), 3000n);
assert.equal(BigInt(`0x${words[3]}`), sell);
assert.equal(BigInt(`0x${words[4]}`), 99n);

const source = readFileSync(new URL("../contracts/robinhood/BlarcRobinhoodFeeRouter.sol", import.meta.url), "utf8");
assert.equal(source.includes("0x729241d4d22cb8bD54E9210D1FE1e16b74A2a784"), true);
assert.equal(source.includes("uint256 public constant FEE_BPS = 100"), true);
assert.equal(source.includes("onlyOwner"), false);
assert.equal(/function\s+setFee/.test(source), false);

const notes = readFileSync(new URL("../contracts/robinhood/README.md", import.meta.url), "utf8");
assert.equal(notes.includes("0x9FC7993E0250D54fE04317A99369Bdd3f0262D58"), true);
assert.equal(/not deployed/i.test(notes), false);
assert.equal(notes.includes("BLARC_ROBINHOOD_ROUTER"), true);

delete process.env.BLARC_ROBINHOOD_ROUTER;
const refused = await executeSwap({
  chatId: "router-test",
  wallet: { address: "0x0000000000000000000000000000000000000001", chainId: "eip155:4663" },
  amount: "1",
  tokenIn: "ETH",
  tokenOut: "0x0000000000000000000000000000000000000001",
});
assert.equal(String(refused).startsWith("Swap could not be prepared."), true);
assert.equal(String(refused).includes("not set"), true);

console.log("robinhood fee router checks ok");
