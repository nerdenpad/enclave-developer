import pino, { type DestinationStream } from "pino";

export const LOG_REDACT_PATHS = [
  "prompt",
  "plaintext",
  "output",
  "ciphertext",
  "privateKey",
  "modelKey",
  "wrappingKey",
  "enclavePrivateKey",
  "vendorPrivateKey",
  "wrapKey",
  "secret",
  "apiKey",
  "hostSecret",
  "goal",
  "authorization",
  "sealedState",
  "sealedPayload",
  "*.prompt",
  "*.plaintext",
  "*.output",
  "*.ciphertext",
  "*.privateKey",
  "*.modelKey",
  "*.wrappingKey",
  "*.enclavePrivateKey",
  "*.vendorPrivateKey",
  "*.wrapKey",
  "*.secret",
  "*.apiKey",
  "*.hostSecret",
  "*.goal",
  "*.authorization",
  "*.sealedState",
  "*.sealedPayload",
];

export function createLogger(level: string, destination?: DestinationStream) {
  const opts = {
    level,
    redact: {
      paths: LOG_REDACT_PATHS,
      censor: "[redacted]",
    },
  };
  return destination ? pino(opts, destination) : pino(opts);
}

export type Logger = ReturnType<typeof createLogger>;
