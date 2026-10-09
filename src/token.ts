const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function importSecret(secretBase64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(secretBase64), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 random bytes, base64-encoded");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

const aad = (interactionId: string, exp: number) => encoder.encode(`dl|${interactionId}|${exp}`);

export async function sealKey(secretBase64: string, apiKey: string, interactionId: string, exp: number): Promise<string> {
  const key = await importSecret(secretBase64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(interactionId, exp) }, key, encoder.encode(apiKey)),
  );
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv);
  out.set(cipher, iv.length);
  return toBase64Url(out);
}

export async function openKey(secretBase64: string, token: string, interactionId: string, exp: number): Promise<string | null> {
  const bytes = fromBase64Url(token);
  if (!bytes || bytes.length < 12 + 16 + 1) return null;
  try {
    const key = await importSecret(secretBase64);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: aad(interactionId, exp) },
      key,
      bytes.slice(12),
    );
    return decoder.decode(plain);
  } catch {
    return null;
  }
}
