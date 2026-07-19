// Node port of the browser crypto layer (src/lib/crypto.js in the web app).
// Wire format must stay byte-compatible: AES-256-GCM with a 12-byte IV
// prepended to the ciphertext, RSA-OAEP-2048/SHA-256 spki keys as plain base64.

import type { webcrypto } from "node:crypto";

// @types/node types globalThis.crypto but does not declare these names globally.
export type CryptoKey = webcrypto.CryptoKey;
export type CryptoKeyPair = webcrypto.CryptoKeyPair;

const AES = "AES-GCM";
const RSA = "RSA-OAEP";

const subtle = globalThis.crypto.subtle;

export interface EncryptedKeyEntry {
  recipientType: "sender" | "receiver";
  encryptedKey: string;
}

const toBase64 = (bytes: ArrayBuffer | Uint8Array): string =>
  Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64");

const fromBase64 = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, "base64"));

export const generateAesKey = (): Promise<CryptoKey> =>
  subtle.generateKey({ name: AES, length: 256 }, true, ["encrypt", "decrypt"]) as Promise<CryptoKey>;

export const generateRsaKeyPair = (): Promise<CryptoKeyPair> =>
  subtle.generateKey(
    {
      name: RSA,
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"]
  ) as Promise<CryptoKeyPair>;

export const exportRsaPublicKey = async (publicKey: CryptoKey): Promise<string> =>
  toBase64(await subtle.exportKey("spki", publicKey));

export const importRsaPublicKey = (publicKeyB64: string): Promise<CryptoKey> =>
  subtle.importKey("spki", fromBase64(publicKeyB64), { name: RSA, hash: "SHA-256" }, true, [
    "encrypt",
  ]);

/** Encrypts bytes; returns IV (12 bytes) || ciphertext+tag — same layout the web app writes. */
export const encryptBytes = async (data: Uint8Array, key: CryptoKey): Promise<Uint8Array> => {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await subtle.encrypt({ name: AES, iv }, key, data);
  const out = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), iv.byteLength);
  return out;
};

/** Decrypts IV-prefixed payloads produced by encryptBytes / the web app. */
export const decryptBytes = async (payload: Uint8Array, key: CryptoKey): Promise<Uint8Array> => {
  const iv = payload.subarray(0, 12);
  const data = payload.subarray(12);
  const plaintext = await subtle.decrypt({ name: AES, iv }, key, data);
  return new Uint8Array(plaintext);
};

export const encryptSymmetricKey = async (
  symmetricKey: CryptoKey,
  rsaPublicKey: CryptoKey
): Promise<string> => {
  const raw = await subtle.exportKey("raw", symmetricKey);
  const encrypted = await subtle.encrypt({ name: RSA }, rsaPublicKey, raw);
  return toBase64(encrypted);
};

export const decryptSymmetricKey = async (
  encryptedKeyB64: string,
  rsaPrivateKey: CryptoKey
): Promise<CryptoKey> => {
  const raw = await subtle.decrypt({ name: RSA }, rsaPrivateKey, fromBase64(encryptedKeyB64));
  return subtle.importKey("raw", raw, { name: AES }, true, ["encrypt", "decrypt"]);
};

export const createBidirectionalEncryptedKeys = async (
  symmetricKey: CryptoKey,
  senderPublicKey: CryptoKey,
  receiverPublicKey: CryptoKey
): Promise<EncryptedKeyEntry[]> => [
  { recipientType: "sender", encryptedKey: await encryptSymmetricKey(symmetricKey, senderPublicKey) },
  {
    recipientType: "receiver",
    encryptedKey: await encryptSymmetricKey(symmetricKey, receiverPublicKey),
  },
];

export const decryptUserSymmetricKey = async (
  entries: EncryptedKeyEntry[],
  privateKey: CryptoKey,
  isSender: boolean
): Promise<CryptoKey> => {
  const recipientType = isSender ? "sender" : "receiver";
  const entry = entries.find((e) => e.recipientType === recipientType);
  if (!entry) throw new Error(`No encrypted key found for ${recipientType}`);
  return decryptSymmetricKey(entry.encryptedKey, privateKey);
};

export const randomHex = (byteLength: number): string =>
  Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(byteLength))).toString("hex");
