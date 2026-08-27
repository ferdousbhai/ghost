/** Secret references stored in portable Ghost configuration. */
import { createHash } from "node:crypto";

export const SECRET_REFERENCE_PREFIX = "keyring:";
export const DEFAULT_SECRET_FIELD = "value";

const COMPONENT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const FIELD_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export interface SecretAccountRef {
  service: string;
  account: string;
}

export interface SecretReference extends SecretAccountRef {
  field: string;
}

export function secretAccountName(ref: SecretAccountRef): string {
  return `${ref.service}/${ref.account}`;
}

export function parseSecretAccountName(value: string): SecretAccountRef {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash !== value.lastIndexOf("/") || slash === value.length - 1) {
    throw new Error(`Invalid keyring account ${JSON.stringify(value)}; expected service/account.`);
  }
  const service = value.slice(0, slash);
  const account = value.slice(slash + 1);
  if (!COMPONENT_PATTERN.test(service) || !COMPONENT_PATTERN.test(account)) {
    throw new Error(
      `Invalid keyring account ${JSON.stringify(value)}; service and account must use lowercase letters, numbers, dots, underscores, or hyphens.`,
    );
  }
  return { service, account };
}

export function parseSecretReference(value: string): SecretReference {
  if (!value.startsWith(SECRET_REFERENCE_PREFIX)) {
    throw new Error(`Invalid keyring reference ${JSON.stringify(value)}.`);
  }
  const reference = value.slice(SECRET_REFERENCE_PREFIX.length);
  const hash = reference.indexOf("#");
  if (hash !== -1 && hash !== reference.lastIndexOf("#")) {
    throw new Error(`Invalid keyring reference ${JSON.stringify(value)}; only one field fragment is allowed.`);
  }
  const accountName = hash === -1 ? reference : reference.slice(0, hash);
  const field = hash === -1 ? DEFAULT_SECRET_FIELD : reference.slice(hash + 1);
  const account = parseSecretAccountName(accountName);
  if (!FIELD_PATTERN.test(field)) {
    throw new Error(`Invalid keyring reference ${JSON.stringify(value)}; its field is invalid.`);
  }
  return { ...account, field };
}

export function formatSecretReference(
  ref: SecretAccountRef,
  field = DEFAULT_SECRET_FIELD,
): string {
  const account = parseSecretAccountName(secretAccountName(ref));
  if (!FIELD_PATTERN.test(field)) throw new Error(`Invalid keyring field ${JSON.stringify(field)}.`);
  return `${SECRET_REFERENCE_PREFIX}${secretAccountName(account)}`
    + (field === DEFAULT_SECRET_FIELD ? "" : `#${field}`);
}

export function isSecretReference(value: unknown): boolean {
  if (typeof value !== "string" || !value.startsWith(SECRET_REFERENCE_PREFIX)) return false;
  try {
    parseSecretReference(value);
    return true;
  } catch {
    return false;
  }
}

export function assertSecretReference(value: string): SecretReference {
  return parseSecretReference(value);
}

/** Keep ordinary provider ids readable and confine opaque MCP credential ids. */
export function serviceForCredentialProvider(provider: string): string {
  if (COMPONENT_PATTERN.test(provider)) return provider;
  const slug = provider.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72)
    || "credential";
  const digest = createHash("sha256").update(provider).digest("hex").slice(0, 16);
  return `provider.${slug}.${digest}`;
}
