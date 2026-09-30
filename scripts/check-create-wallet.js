import { entropyToMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { createWallet, publicAddressesFromMnemonic, sanitizeCreatedWallet, slip10Ed25519PublicKey } from "../src/createWallet.js";

const expectedEvm = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const expectedSolana = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
const failures = [];

function fail(code) {
  failures.push(code);
}

const zeroEntropy = new Uint8Array(16);
const fromEntropy = entropyToMnemonic(zeroEntropy, wordlist);
const derived = publicAddressesFromMnemonic(fromEntropy);
if (derived.evm !== expectedEvm) {
  fail(`evm ${derived.evm}`);
}
if (derived.solana !== expectedSolana) {
  fail(`solana ${derived.solana}`);
}

const slipSeed = Uint8Array.from([
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
  0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
]);
const masterPub = bytesToHex(slip10Ed25519PublicKey(slipSeed, "m"));
const childPub = bytesToHex(slip10Ed25519PublicKey(slipSeed, "m/0'"));
if (masterPub !== "a4b2856bfec510abab89753fac1ac0e1112364e7d250545963f135f2a33188ed") {
  fail("slip10 master public");
}
if (childPub !== "8c8a13df77a28f3445213a0f432fde644acaa215fc72dcdf300d5efaa85d350c") {
  fail("slip10 child public");
}

const created = createWallet();
const words = created.mnemonic.split(" ");
if (words.length !== 12 || !validateMnemonic(created.mnemonic, wordlist)) {
  fail("generated mnemonic shape");
}
if (!/^0x[a-fA-F0-9]{40}$/.test(created.evm)) {
  fail("generated evm");
}
if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(created.solana || "")) {
  fail("generated solana");
}
const again = publicAddressesFromMnemonic(created.mnemonic);
if (again.evm !== created.evm || again.solana !== created.solana) {
  fail("not deterministic");
}

const dirty = sanitizeCreatedWallet({
  evm: expectedEvm.toLowerCase(),
  solana: expectedSolana,
  mnemonic: "not-stored",
  privateKey: "not-stored",
  xprv: "not-stored",
});
const serialized = JSON.stringify(dirty);
if (!dirty || dirty.evm !== expectedEvm || dirty.solana !== expectedSolana) {
  fail("sanitize addresses");
}
if (serialized.includes("not-stored") || "mnemonic" in dirty || "privateKey" in dirty || "xprv" in dirty) {
  fail("sanitize leaked");
}
if (Object.keys(dirty).some((key) => key !== "evm" && key !== "solana")) {
  fail("sanitize keys");
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("create wallet checks passed");
