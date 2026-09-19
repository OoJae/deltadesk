// `pnpm gen-rsa [--out data/dynamic-rsa-private.pem] [--force]`: the RSA-4096 key pair Dynamic uses
// to encrypt delegated key shares to us (RSA-OAEP-SHA256 wrapping an AES-256-GCM key).
//
// The PRIVATE key is written to --out with mode 0600 (never printed); point
// DYNAMIC_RSA_PRIVATE_KEY_PATH at it, or paste it into DYNAMIC_RSA_PRIVATE_KEY_PEM as a sealed
// Railway variable. The PUBLIC key (SPKI PEM) is written next to it as *.pub.pem and printed, for
// upload in the Dynamic dashboard (Delegated Access → encryption key).

import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_RSA_OUT = "data/dynamic-rsa-private.pem";

export function generateRsaKeyPair(modulusLength = 4096): {
  publicKeyPem: string;
  privateKeyPem: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength,
    publicExponent: 0x10001,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

export function publicPathFor(privatePath: string): string {
  return privatePath.replace(/(\.pem)?$/, ".pub.pem");
}

export function writeRsaKeyPair(
  out: string,
  force: boolean,
  modulusLength = 4096,
): { publicKeyPem: string; publicPath: string } {
  if (existsSync(out) && !force) {
    throw new Error(
      `${out} already exists; refusing to overwrite a live key (pass --force to rotate)`,
    );
  }
  const { publicKeyPem, privateKeyPem } = generateRsaKeyPair(modulusLength);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, privateKeyPem, { mode: 0o600, flag: force ? "w" : "wx" });
  const publicPath = publicPathFor(out);
  writeFileSync(publicPath, publicKeyPem, { mode: 0o644 });
  return { publicKeyPem, publicPath };
}

function main(argv: string[]): void {
  const i = argv.indexOf("--out");
  const out = i >= 0 && argv[i + 1] !== undefined ? (argv[i + 1] as string) : DEFAULT_RSA_OUT;
  const { publicKeyPem, publicPath } = writeRsaKeyPair(out, argv.includes("--force"));
  console.log(`private key: ${out} (mode 0600; never commit or print it)`);
  console.log(`public key:  ${publicPath}\n`);
  console.log(publicKeyPem);
  console.log(
    "Upload the public key above in Dynamic → Delegated Access, then set DYNAMIC_RSA_PRIVATE_KEY_PATH.",
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
