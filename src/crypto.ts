// Keep this aligned with the verifier floor and within Cloudflare Workers runtime limits.
const PASSWORD_ITERATIONS = 100_000;
const PASSWORD_KEY_BITS = 256;
const PASSWORD_SALT_BYTES = 16;
const TOKEN_BYTES = 32;

const encoder = new TextEncoder();

export function randomId(prefix: string): string {
  return `${prefix}_${randomBase64Url(18)}`;
}

export function randomToken(): string {
  return `vgr_${randomBase64Url(TOKEN_BYTES)}`;
}

export function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(PASSWORD_SALT_BYTES);
  crypto.getRandomValues(salt);
  const key = await derivePasswordKey(password, salt, PASSWORD_ITERATIONS);
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(key)}`;
}

export async function verifyPassword(password: string, verifier: string): Promise<boolean> {
  const [algorithm, iterationsText, saltText, expectedText] = verifier.split("$");
  if (algorithm !== "pbkdf2-sha256" || !iterationsText || !saltText || !expectedText) {
    return false;
  }
  const iterations = Number(iterationsText);
  if (!Number.isInteger(iterations) || iterations < 100_000) {
    return false;
  }
  const salt = base64UrlToBytes(saltText);
  const expected = base64UrlToBytes(expectedText);
  const actual = await derivePasswordKey(password, salt, iterations);
  return timingSafeEqual(actual, expected);
}

async function derivePasswordKey(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations
    },
    keyMaterial,
    PASSWORD_KEY_BITS
  );
  return new Uint8Array(bits);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }
  return diff === 0;
}
