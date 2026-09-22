const BANNED_FIELD_NAMES = new Set([
  "wrappingKey",
  "enclavePrivateKey",
  "vendorPrivateKey",
  "modelKey",
  "privateKey",
  "plaintext",
  "prompt",
  "memoryPlaintext",
]);

export function bannedSecretFields(value: unknown, acc: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      bannedSecretFields(item, acc);
    }
    return acc;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (BANNED_FIELD_NAMES.has(key) && !acc.includes(key)) {
        acc.push(key);
      }
      bannedSecretFields(nested, acc);
    }
  }
  return acc;
}

export function secretMaterialHits(payload: unknown, material: string[]): string[] {
  const hay = JSON.stringify(payload).toLowerCase();
  return material.filter((item) => {
    const raw = item.toLowerCase();
    const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
    if (hex.length < 16) {
      return false;
    }
    return hay.includes(raw) || hay.includes(hex);
  });
}
