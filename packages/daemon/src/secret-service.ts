/** Linux Secret Service access, isolated behind a deterministic test seam. */
import { spawnSync } from "node:child_process";
import { GhostError } from "./ghosts.js";
import {
  parseSecretAccountName,
  secretAccountName,
  type SecretAccountRef,
} from "./secret-reference.js";

export const GHOST_SECRET_SCHEMA = "io.github.ferdousbhai.ghost.Secret";

export class SecretServiceError extends GhostError {
  constructor(
    code: "keyring_unavailable" | "keyring_locked" | "secret_reference_missing"
      | "secret_not_authorized" | "invalid_secret_reference" | "secret_migration_failed",
    message: string,
    status = 503,
  ) {
    super(code, message, status);
    this.name = "SecretServiceError";
  }
}

export interface SecretServiceClient {
  assertAvailable(): void;
  read(ref: SecretAccountRef): string | null;
  write(ref: SecretAccountRef, secret: string): void;
  clear(ref: SecretAccountRef): void;
}

const LOCKED_MESSAGE =
  "Ghost cannot open credentials because the default Linux keyring is locked. Unlock it in this desktop session and retry.";

function commandFailure(command: string, stderr: string): SecretServiceError {
  const detail = stderr.trim();
  if (/locked|islocked/i.test(detail)) {
    return new SecretServiceError("keyring_locked", LOCKED_MESSAGE);
  }
  return new SecretServiceError(
    "keyring_unavailable",
    `Ghost cannot open credentials because Linux Secret Service is unavailable (${command} failed). Start an org.freedesktop.secrets service on the user bus and retry.`,
  );
}

function itemAttributes(ref: SecretAccountRef): string[] {
  return ["xdg:schema", GHOST_SECRET_SCHEMA, "service", ref.service, "account", ref.account];
}

/**
 * libsecret's mature CLI handles the Secret Service session/encryption
 * handshake. gdbus is used only for an explicit availability/lock probe so a
 * missing item is never confused with a missing or locked service.
 */
export class SecretToolServiceClient implements SecretServiceClient {
  assertAvailable(): void {
    const result = spawnSync(
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        "org.freedesktop.secrets",
        "--object-path",
        "/org/freedesktop/secrets/aliases/default",
        "--method",
        "org.freedesktop.DBus.Properties.Get",
        "org.freedesktop.Secret.Collection",
        "Locked",
      ],
      { encoding: "utf8", timeout: 5_000 },
    );
    if (result.error || result.status !== 0) {
      throw commandFailure("gdbus", result.stderr ?? String(result.error ?? ""));
    }
    if (/\btrue\b/i.test(result.stdout)) {
      throw new SecretServiceError("keyring_locked", LOCKED_MESSAGE);
    }
    if (!/\bfalse\b/i.test(result.stdout)) {
      throw commandFailure("gdbus", "Secret Service returned an invalid Locked property.");
    }
  }

  private target(input: SecretAccountRef): SecretAccountRef {
    const ref = parseSecretAccountName(secretAccountName(input));
    this.assertAvailable();
    return ref;
  }

  read(input: SecretAccountRef): string | null {
    const ref = this.target(input);
    const result = spawnSync(
      "secret-tool",
      ["lookup", ...itemAttributes(ref)],
      { encoding: "utf8", timeout: 5_000 },
    );
    if (result.error) throw commandFailure("secret-tool lookup", String(result.error));
    if (result.status === 1 && result.stderr.trim() === "" && result.stdout === "") return null;
    if (result.status !== 0) throw commandFailure("secret-tool lookup", result.stderr);
    return result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
  }

  write(input: SecretAccountRef, secret: string): void {
    const ref = this.target(input);
    const result = spawnSync(
      "secret-tool",
      ["store", `--label=Ghost secret: ${secretAccountName(ref)}`, ...itemAttributes(ref)],
      { encoding: "utf8", input: secret, timeout: 5_000 },
    );
    if (result.error || result.status !== 0) {
      throw commandFailure("secret-tool store", result.stderr ?? String(result.error ?? ""));
    }
  }

  clear(input: SecretAccountRef): void {
    const ref = this.target(input);
    const result = spawnSync(
      "secret-tool",
      ["clear", ...itemAttributes(ref)],
      { encoding: "utf8", timeout: 5_000 },
    );
    if (result.error || (result.status !== 0 && result.status !== 1)) {
      throw commandFailure("secret-tool clear", result.stderr ?? String(result.error ?? ""));
    }
  }
}

export class MemorySecretServiceClient implements SecretServiceClient {
  readonly items = new Map<string, string>();
  available = true;
  locked = false;

  assertAvailable(): void {
    if (!this.available) {
      throw new SecretServiceError(
        "keyring_unavailable",
        "Ghost cannot open credentials because Linux Secret Service is unavailable.",
      );
    }
    if (this.locked) {
      throw new SecretServiceError(
        "keyring_locked",
        "Ghost cannot open credentials because the default Linux keyring is locked.",
      );
    }
  }

  read(ref: SecretAccountRef): string | null {
    this.assertAvailable();
    return this.items.get(secretAccountName(ref)) ?? null;
  }

  write(ref: SecretAccountRef, secret: string): void {
    this.assertAvailable();
    this.items.set(secretAccountName(ref), secret);
  }

  clear(ref: SecretAccountRef): void {
    this.assertAvailable();
    this.items.delete(secretAccountName(ref));
  }

  reset(): void {
    this.items.clear();
    this.available = true;
    this.locked = false;
  }
}

export type SecretServiceClientFactory = () => SecretServiceClient;

let defaultClientFactory: SecretServiceClientFactory = () => new SecretToolServiceClient();

export function createSecretServiceClient(): SecretServiceClient {
  return defaultClientFactory();
}

export function setSecretServiceClientFactoryForTests(factory: SecretServiceClientFactory): void {
  if (!process.env.GHOST_TEST_XDG_STATE_HOME) {
    throw new Error("The Secret Service test factory is available only under the daemon test harness.");
  }
  defaultClientFactory = factory;
}
