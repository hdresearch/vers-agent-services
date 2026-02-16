import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import {
  signContent,
  verifyContent,
  encryptContent,
  decryptContent,
  isRealSignature,
  parseSSHPublicKey,
  parseSSHPrivateKey,
} from "../crypto.js";

const TEST_KEY_PATH = "/tmp/fleet-chat-crypto-test-key";
const TEST_KEY_PUB_PATH = `${TEST_KEY_PATH}.pub`;

beforeAll(() => {
  // Generate a fresh test key pair
  if (existsSync(TEST_KEY_PATH)) {
    execSync(`rm -f ${TEST_KEY_PATH} ${TEST_KEY_PUB_PATH}`);
  }
  execSync(`ssh-keygen -t ed25519 -f ${TEST_KEY_PATH} -N "" -C "crypto-test" -q`);
});

describe("Ed25519 signing", () => {
  it("signContent returns a base64 string", async () => {
    const sig = await signContent("hello world", TEST_KEY_PATH);
    expect(sig).toBeTruthy();
    expect(typeof sig).toBe("string");
    // base64 of 64 bytes
    const buf = Buffer.from(sig, "base64");
    expect(buf.length).toBe(64);
  });

  it("sign + verify roundtrip", async () => {
    const content = "fleet protocol message";
    const pubKey = readFileSync(TEST_KEY_PUB_PATH, "utf-8").trim();
    const sig = await signContent(content, TEST_KEY_PATH);
    const valid = verifyContent(content, sig, pubKey);
    expect(valid).toBe(true);
  });

  it("verify rejects tampered content", async () => {
    const pubKey = readFileSync(TEST_KEY_PUB_PATH, "utf-8").trim();
    const sig = await signContent("original message", TEST_KEY_PATH);
    const valid = verifyContent("tampered message", sig, pubKey);
    expect(valid).toBe(false);
  });

  it("verify rejects wrong public key", async () => {
    // Generate a second key pair
    const otherKeyPath = "/tmp/fleet-chat-crypto-other-key";
    execSync(`ssh-keygen -t ed25519 -f ${otherKeyPath} -N "" -C "other" -q 2>/dev/null || true`);
    if (!existsSync(otherKeyPath)) {
      execSync(`rm -f ${otherKeyPath} ${otherKeyPath}.pub && ssh-keygen -t ed25519 -f ${otherKeyPath} -N "" -C "other" -q`);
    }
    const otherPub = readFileSync(`${otherKeyPath}.pub`, "utf-8").trim();

    const sig = await signContent("message", TEST_KEY_PATH);
    const valid = verifyContent("message", sig, otherPub);
    expect(valid).toBe(false);

    execSync(`rm -f ${otherKeyPath} ${otherKeyPath}.pub`);
  });

  it("verifyContent returns false for garbage input", () => {
    expect(verifyContent("test", "not-base64", "not-a-key")).toBe(false);
  });
});

describe("isRealSignature", () => {
  it("identifies real 64-byte Ed25519 signatures", async () => {
    const sig = await signContent("test", TEST_KEY_PATH);
    expect(isRealSignature(sig)).toBe(true);
  });

  it("rejects short/hash-based signatures", () => {
    // SHA-256 hash is 32 bytes, not 64
    expect(isRealSignature(Buffer.alloc(32).toString("base64"))).toBe(false);
  });

  it("rejects garbage", () => {
    expect(isRealSignature("not-real")).toBe(false);
  });
});

describe("SSH key parsing", () => {
  it("parses SSH public key to 32 bytes", () => {
    const pubKey = readFileSync(TEST_KEY_PUB_PATH, "utf-8").trim();
    const raw = parseSSHPublicKey(pubKey);
    expect(raw.length).toBe(32);
  });

  it("parses SSH private key to 32-byte seed", () => {
    const seed = parseSSHPrivateKey(TEST_KEY_PATH);
    expect(seed.length).toBe(32);
  });

  it("parses noah-fleet public key", () => {
    const raw = parseSSHPublicKey(
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIECLWJulrdIzkLMbSt3n3fopUC5vMm2kEH9vQVQhSDEB noah-fleet",
    );
    expect(raw.length).toBe(32);
  });

  it("parses joseph-fleet public key", () => {
    const raw = parseSSHPublicKey(
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAGvI0cLzTp4XrHHbbH4wR+083yCX+CxJM6GwjbUZzUb joseph-fleet",
    );
    expect(raw.length).toBe(32);
  });

  it("rejects non-ed25519 keys", () => {
    expect(() => parseSSHPublicKey("ssh-rsa AAAA... comment")).toThrow("Unsupported key type");
  });
});

describe("age encryption", () => {
  it("encrypt + decrypt roundtrip", async () => {
    const pubKey = readFileSync(TEST_KEY_PUB_PATH, "utf-8").trim();
    const plaintext = "top secret fleet message";

    const ciphertext = await encryptContent(plaintext, pubKey);
    expect(ciphertext).toBeTruthy();
    expect(typeof ciphertext).toBe("string");
    // Should be base64
    expect(() => Buffer.from(ciphertext, "base64")).not.toThrow();

    const decrypted = await decryptContent(ciphertext, TEST_KEY_PATH);
    expect(decrypted).toBe(plaintext);
  });

  it("encrypts with full SSH public key string", async () => {
    const pubKey = readFileSync(TEST_KEY_PUB_PATH, "utf-8").trim();
    const ciphertext = await encryptContent("test", pubKey);
    const decrypted = await decryptContent(ciphertext, TEST_KEY_PATH);
    expect(decrypted).toBe("test");
  });

  it("handles multi-line content", async () => {
    const pubKey = readFileSync(TEST_KEY_PUB_PATH, "utf-8").trim();
    const content = "line 1\nline 2\nline 3\n";
    const ct = await encryptContent(content, pubKey);
    const dec = await decryptContent(ct, TEST_KEY_PATH);
    expect(dec).toBe(content);
  });

  it("handles unicode content", async () => {
    const pubKey = readFileSync(TEST_KEY_PUB_PATH, "utf-8").trim();
    const content = "🚀 fleet-to-fleet encrypted message 日本語";
    const ct = await encryptContent(content, pubKey);
    const dec = await decryptContent(ct, TEST_KEY_PATH);
    expect(dec).toBe(content);
  });

  it("decrypt fails with wrong key", async () => {
    const pubKey = readFileSync(TEST_KEY_PUB_PATH, "utf-8").trim();
    const ct = await encryptContent("secret", pubKey);

    // Try to decrypt with a different key
    const otherKeyPath = "/tmp/fleet-chat-crypto-other-key-2";
    execSync(`rm -f ${otherKeyPath} ${otherKeyPath}.pub`);
    execSync(`ssh-keygen -t ed25519 -f ${otherKeyPath} -N "" -C "other2" -q`);

    await expect(decryptContent(ct, otherKeyPath)).rejects.toThrow();
    execSync(`rm -f ${otherKeyPath} ${otherKeyPath}.pub`);
  });
});

describe("integration: sign encrypted content", () => {
  it("sign ciphertext, verify, then decrypt", async () => {
    const pubKey = readFileSync(TEST_KEY_PUB_PATH, "utf-8").trim();
    const plaintext = "encrypted and signed";

    // Encrypt
    const ciphertext = await encryptContent(plaintext, pubKey);

    // Sign the ciphertext (what gets sent over the wire)
    const sig = await signContent(ciphertext, TEST_KEY_PATH);

    // Receiver: verify signature on ciphertext
    const valid = verifyContent(ciphertext, sig, pubKey);
    expect(valid).toBe(true);

    // Receiver: decrypt
    const decrypted = await decryptContent(ciphertext, TEST_KEY_PATH);
    expect(decrypted).toBe(plaintext);
  });
});
