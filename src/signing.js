// Ed25519 over node:crypto. No runtime dependencies.
//
// Two independent keys, never interchangeable:
//   gate key     — signs receipts, proving the log was not edited after the fact.
//   approver key — signs approval grants, proving a human authorised one exact action.
import {
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

/** Generate an Ed25519 keypair as base64 DER (pkcs8 private, spki public). */
export function generateKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

/** Public key (base64 spki) derived from a base64 pkcs8 private key. */
export function publicKeyOf(privateKeyB64) {
  const key = createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" });
  return createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64");
}

/** Sign a UTF-8 message. Returns base64. */
export function signMessage(message, privateKeyB64) {
  const key = createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" });
  return cryptoSign(null, Buffer.from(message, "utf8"), key).toString("base64");
}

/** Verify a base64 signature over a UTF-8 message. Never throws. */
export function verifyMessage(message, signatureB64, publicKeyB64) {
  if (!signatureB64 || !publicKeyB64) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
    return cryptoVerify(null, Buffer.from(message, "utf8"), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

/** Write a private key 0600. */
export function writeKeyFile(path, privateKeyB64) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, privateKeyB64 + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** Read a private key file. Returns null when absent. */
export function readKeyFile(path) {
  if (!path || !existsSync(path)) return null;
  return readFileSync(path, "utf8").trim();
}

/** True when a key file is readable by group or other. */
export function isKeyFileExposed(path) {
  if (!existsSync(path)) return false;
  return (statSync(path).mode & 0o077) !== 0;
}
