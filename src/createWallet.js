import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";

const EVM_PATH = "m/44'/60'/0'/0/0";
const SOLANA_PATH = "m/44'/501'/0'/0'";
const HARDENED = 0x80000000;
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function createWallet() {
  const mnemonic = generateMnemonic(wordlist, 128);
  const addresses = publicAddressesFromMnemonic(mnemonic);
  return { mnemonic, evm: addresses.evm, solana: addresses.solana };
}

export function publicAddressesFromMnemonic(mnemonic) {
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error("invalid mnemonic");
  }
  const seed = mnemonicToSeedSync(mnemonic, "");
  try {
    return {
      evm: evmAddressFromSeed(seed),
      solana: solanaAddressFromSeed(seed),
    };
  } finally {
    seed.fill(0);
  }
}

export function sanitizeCreatedWallet(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const evm = typeof value.evm === "string" && EVM_ADDRESS.test(value.evm) ? checksumAddress(value.evm.slice(2)) : null;
  const solana = typeof value.solana === "string" && SOLANA_ADDRESS.test(value.solana) ? value.solana : null;
  if (!evm && !solana) {
    return null;
  }
  const clean = {};
  if (evm) {
    clean.evm = evm;
  }
  if (solana) {
    clean.solana = solana;
  }
  return clean;
}

export function slip10Ed25519PublicKey(seed, path) {
  const node = deriveSlip10(seed, path);
  const secret = new Uint8Array(node.key);
  try {
    const pub = ed25519.getPublicKey(secret);
    if (pub.length !== 32) {
      throw new Error("ed25519 public key length");
    }
    return pub;
  } finally {
    secret.fill(0);
    node.key.fill(0);
    node.chain.fill(0);
  }
}

function evmAddressFromSeed(seed) {
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive(EVM_PATH);
  const priv = child.privateKey;
  const secret = priv ? new Uint8Array(priv) : null;
  try {
    if (!secret || secret.length !== 32) {
      throw new Error("evm derive failed");
    }
    const uncompressed = secp256k1.getPublicKey(secret, false);
    if (uncompressed.length !== 65 || uncompressed[0] !== 4) {
      throw new Error("evm public key");
    }
    const hash = keccak_256(uncompressed.subarray(1));
    return checksumAddress(bytesToHex(hash.subarray(12)));
  } finally {
    secret?.fill(0);
    child.wipePrivateData();
    root.wipePrivateData();
  }
}

function solanaAddressFromSeed(seed) {
  return base58.encode(slip10Ed25519PublicKey(seed, SOLANA_PATH));
}

function deriveSlip10(seed, path) {
  const text = String(path || "");
  if (text !== "m" && !text.startsWith("m/")) {
    throw new Error("bad path");
  }
  let node = slip10Master(seed);
  if (text === "m") {
    return node;
  }
  for (const part of text.slice(2).split("/")) {
    if (!part.endsWith("'")) {
      node.key.fill(0);
      node.chain.fill(0);
      throw new Error("ed25519 path must be hardened");
    }
    const index = Number(part.slice(0, -1));
    if (!Number.isInteger(index) || index < 0 || index >= HARDENED) {
      node.key.fill(0);
      node.chain.fill(0);
      throw new Error("bad path index");
    }
    node = slip10Child(node, HARDENED + index);
  }
  return node;
}

function slip10Master(seed) {
  const material = hmac(sha512, new TextEncoder().encode("ed25519 seed"), seed);
  return { key: material.slice(0, 32), chain: material.slice(32) };
}

function slip10Child(parent, index) {
  const data = new Uint8Array(37);
  data[0] = 0;
  data.set(parent.key, 1);
  new DataView(data.buffer).setUint32(33, index);
  const material = hmac(sha512, parent.chain, data);
  parent.key.fill(0);
  parent.chain.fill(0);
  data.fill(0);
  return { key: material.slice(0, 32), chain: material.slice(32) };
}

function checksumAddress(hexBody) {
  const hex = String(hexBody).toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(hex)) {
    throw new Error("bad address");
  }
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(hex)));
  let out = "0x";
  for (let i = 0; i < hex.length; i += 1) {
    out += Number.parseInt(hash[i], 16) >= 8 ? hex[i].toUpperCase() : hex[i];
  }
  return out;
}
