/**
 * Fleet-chat cryptographic primitives.
 *
 * Ed25519 signing/verification using Node.js crypto (pure, no deps).
 * age encryption/decryption shelling out to the `age` binary.
 *
 * SSH ed25519 keys are the canonical format — we parse them ourselves
 * since Node.js crypto doesn't natively handle OpenSSH key formats.
 */

import { sign, verify, createPublicKey, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

// ── DER prefixes for Ed25519 key wrapping ──────────────────────────────

/** SPKI DER prefix for Ed25519 public keys (prepend to 32-byte raw key) */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** PKCS8 DER prefix for Ed25519 private keys (prepend to 32-byte seed) */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

// ── SSH key parsing ────────────────────────────────────────────────────

/** Read a length-prefixed string from a buffer at given offset */
function readSSHString(buf: Buffer, offset: number): [Buffer, number] {
  const len = buf.readUInt32BE(offset);
  offset += 4;
  const data = buf.subarray(offset, offset + len);
  offset += len;
  return [data, offset];
}

/**
 * Extract the raw 32-byte Ed25519 public key from an SSH public key string.
 * Format: "ssh-ed25519 <base64data> <comment>"
 */
export function parseSSHPublicKey(sshPubKey: string): Buffer {
  const parts = sshPubKey.trim().split(/\s+/);
  if (parts[0] !== "ssh-ed25519") {
    throw new Error(`Unsupported key type: ${parts[0]} (expected ssh-ed25519)`);
  }
  const keyData = Buffer.from(parts[1], "base64");

  let offset = 0;
  let keyType: Buffer;
  [keyType, offset] = readSSHString(keyData, offset);
  if (keyType.toString() !== "ssh-ed25519") {
    throw new Error("Key type mismatch in encoded data");
  }

  let rawKey: Buffer;
  [rawKey, offset] = readSSHString(keyData, offset);
  if (rawKey.length !== 32) {
    throw new Error(`Expected 32-byte Ed25519 key, got ${rawKey.length}`);
  }

  return rawKey;
}

/**
 * Parse an OpenSSH ed25519 private key file and extract the 32-byte seed.
 * Supports unencrypted keys only.
 */
export function parseSSHPrivateKey(keyPath: string): Buffer {
  const content = readFileSync(keyPath, "utf-8");
  const lines = content.split("\n");
  const b64 = lines.filter((l) => !l.startsWith("-----") && l.trim()).join("");
  const buf = Buffer.from(b64, "base64");

  // Verify magic: "openssh-key-v1\0"
  const magic = buf.subarray(0, 15).toString();
  if (magic !== "openssh-key-v1\0") {
    throw new Error("Not an OpenSSH private key file");
  }

  let offset = 15;
  let cipher: Buffer;
  [cipher, offset] = readSSHString(buf, offset);
  if (cipher.toString() !== "none") {
    throw new Error("Encrypted SSH keys are not supported (cipher: " + cipher.toString() + ")");
  }

  // Skip kdf name and kdf options
  let _kdf: Buffer;
  [_kdf, offset] = readSSHString(buf, offset);
  let _kdfopts: Buffer;
  [_kdfopts, offset] = readSSHString(buf, offset);

  // Number of keys
  const numKeys = buf.readUInt32BE(offset);
  offset += 4;
  if (numKeys !== 1) {
    throw new Error(`Expected 1 key, found ${numKeys}`);
  }

  // Skip public key blob
  let _pubBlob: Buffer;
  [_pubBlob, offset] = readSSHString(buf, offset);

  // Private section
  let privSection: Buffer;
  [privSection, offset] = readSSHString(buf, offset);

  // Parse private section
  let po = 0;
  const check1 = privSection.readUInt32BE(po);
  po += 4;
  const check2 = privSection.readUInt32BE(po);
  po += 4;
  if (check1 !== check2) {
    throw new Error("Check integers don't match — key may be corrupt or encrypted");
  }

  // Key type
  let keyType: Buffer;
  [keyType, po] = readSSHString(privSection, po);
  if (keyType.toString() !== "ssh-ed25519") {
    throw new Error(`Unsupported key type: ${keyType.toString()}`);
  }

  // Public key (32 bytes)
  let _pubKey: Buffer;
  [_pubKey, po] = readSSHString(privSection, po);

  // Private key (64 bytes: 32-byte seed + 32-byte public key)
  let privKey: Buffer;
  [privKey, po] = readSSHString(privSection, po);
  if (privKey.length !== 64) {
    throw new Error(`Expected 64-byte ed25519 private blob, got ${privKey.length}`);
  }

  return privKey.subarray(0, 32); // Return just the 32-byte seed
}

// ── Node.js crypto key objects ─────────────────────────────────────────

/** Convert a 32-byte raw Ed25519 public key to a Node.js KeyObject */
function rawToPublicKeyObject(raw32: Buffer) {
  const der = Buffer.concat([ED25519_SPKI_PREFIX, raw32]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

/** Convert a 32-byte Ed25519 seed to a Node.js KeyObject */
function seedToPrivateKeyObject(seed32: Buffer) {
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, seed32]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Sign content with an Ed25519 private key (SSH format on disk).
 * Returns a base64-encoded Ed25519 signature.
 */
export async function signContent(content: string, privateKeyPath: string): Promise<string> {
  const seed = parseSSHPrivateKey(privateKeyPath);
  const privKey = seedToPrivateKeyObject(seed);
  const signature = sign(null, Buffer.from(content, "utf-8"), privKey);
  return signature.toString("base64");
}

/**
 * Verify an Ed25519 signature against content and an SSH public key string.
 * Returns true if valid.
 */
export function verifyContent(content: string, signatureB64: string, sshPublicKey: string): boolean {
  try {
    const raw32 = parseSSHPublicKey(sshPublicKey);
    const pubKey = rawToPublicKeyObject(raw32);
    const signature = Buffer.from(signatureB64, "base64");
    return verify(null, Buffer.from(content, "utf-8"), pubKey, signature);
  } catch {
    return false;
  }
}

/**
 * Encrypt content using age with the recipient's SSH ed25519 public key.
 * Returns base64-encoded age ciphertext.
 */
export async function encryptContent(content: string, recipientSSHPubKey: string): Promise<string> {
  return _ageEncrypt(content, recipientSSHPubKey);
}

async function _ageEncrypt(content: string, recipientPubKey: string): Promise<string> {
  const tmpIn = join(tmpdir(), `age-in-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const tmpOut = join(tmpdir(), `age-out-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    writeFileSync(tmpIn, content, "utf-8");
    await execFileAsync("age", ["-r", recipientPubKey, "-e", "-o", tmpOut, tmpIn]);
    const ciphertext = readFileSync(tmpOut);
    return ciphertext.toString("base64");
  } finally {
    try { unlinkSync(tmpIn); } catch {}
    try { unlinkSync(tmpOut); } catch {}
  }
}

/**
 * Decrypt age-encrypted content using our SSH ed25519 private key.
 * Input is base64-encoded age ciphertext.
 */
export async function decryptContent(ciphertextB64: string, privateKeyPath: string): Promise<string> {
  const tmpIn = join(tmpdir(), `age-dec-in-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const tmpOut = join(tmpdir(), `age-dec-out-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    const ciphertext = Buffer.from(ciphertextB64, "base64");
    writeFileSync(tmpIn, ciphertext);
    await execFileAsync("age", ["-d", "-i", privateKeyPath, "-o", tmpOut, tmpIn]);
    return readFileSync(tmpOut, "utf-8");
  } finally {
    try { unlinkSync(tmpIn); } catch {}
    try { unlinkSync(tmpOut); } catch {}
  }
}

// ── Convenience: check if a signature looks like a real Ed25519 sig ────

/**
 * Returns true if the signature looks like a real Ed25519 signature
 * (64 bytes when base64-decoded) rather than a placeholder hash.
 */
export function isRealSignature(signatureB64: string): boolean {
  try {
    const buf = Buffer.from(signatureB64, "base64");
    return buf.length === 64;
  } catch {
    return false;
  }
}
