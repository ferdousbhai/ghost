/** Idempotent migration from portable plaintext into machine Secret Service. */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  type BigIntStats,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import type { Credential as AuthCredential } from "@earendil-works/pi-ai";
import { type MCPServerConfig, withMCPConfigWriteLock } from "./mcp-config.js";
import {
  addGhostAccounts,
  ghostModelsPath,
  readGhostModelsSnapshot,
  type GhostModelsFile,
  type GhostProviderConfig,
  withSerializedModelsWrite,
} from "./models.js";
import {
  authorizedSecretReference,
  GhostSecretContext,
  validateAuthCredential,
} from "./keyring-credential-store.js";
import { mcpServerValidationErrors } from "./mcp-server-shape.js";
import {
  fsyncPath,
  type PrivateFileIdentity,
  PrivateReadError,
  readPrivateFile,
  readPrivateFilePinned,
  writePrivateJsonAtomicCas,
  writePrivateJsonAtomicSync,
} from "./private-file.js";
import {
  DEFAULT_SECRET_FIELD,
  formatSecretReference,
  isSecretReference,
  SECRET_REFERENCE_PREFIX,
  secretAccountName,
  serviceForCredentialProvider,
  type SecretAccountRef,
} from "./secret-reference.js";
import { SecretServiceError, type SecretServiceClient } from "./secret-service.js";

const MCP_FILENAME = "mcp.json";
const SENSITIVE_NAME = /(?:^|[-_])(api[-_]?key|auth|bearer|credential|password|secret|token)(?:$|[-_])/i;
const SENSITIVE_ARGUMENT_VALUE = /(?:authorization\s*:|bearer\s+|api[-_ ]?key\s*[:=])/i;

interface PlainCredentialRow {
  provider: string;
  credential: AuthCredential;
}

interface McpConfigDocument {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface GhostSecretMigrationOptions {
  home: string;
  authPath?: string;
  client?: SecretServiceClient;
  metadataPath?: string;
  /** Synchronous adversarial seam around the claimed legacy database. */
  agentDbProbe?: (
    stage: "admitted" | "opening" | "claimed" | "scrubbing" | "scrubbed",
    path: string,
  ) => void;
  /** Synchronous adversarial seam around a read plaintext source. */
  plainFileProbe?: (stage: "removing", path: string) => void;
  /** Test-only abrupt-stop seam for durable auth.json removal recovery. */
  plainFileFault?: (stage: PlainFileFaultStage, path: string) => void;
  /** Test-only abrupt-stop seam; durable claim evidence is deliberately retained. */
  agentDbFault?: (stage: AgentDbFaultStage, path: string) => void;
  /** Synchronous adversarial seam immediately before portable CAS publication. */
  portableCommitProbe?: (source: "models" | "mcp", path: string) => void;
}

export type AgentDbFaultStage =
  | "state-written"
  | "file-renamed"
  | "phase-claimed"
  | "phase-committed"
  | "phase-scrubbing"
  | "phase-scrubbed"
  | "main-linked"
  | "main-unlinked"
  | "claim-entry-unlinked"
  | "state-unlinked";

export type PlainFileFaultStage =
  | "state-written"
  | "anchor-linked"
  | "phase-anchored"
  | "file-renamed"
  | "phase-claimed"
  | "claim-unlinked"
  | "replacement-linked"
  | "anchor-unlinked"
  | "state-unlinked";

function refusedSource(path: string, error: PrivateReadError): SecretServiceError {
  switch (error.refusal) {
    case "open":
      return new SecretServiceError(
        "secret_migration_failed",
        `Ghost refused to migrate unsafe plaintext source ${path}: ${(error.cause as Error).message}`,
      );
    case "unsafe":
      return new SecretServiceError(
        "secret_migration_failed",
        `Ghost refused to migrate unsafe plaintext source ${path}.`,
      );
    case "too_large":
      return new SecretServiceError(
        "secret_migration_failed",
        `Ghost refused to migrate ${path} because it exceeds 1 MiB.`,
      );
    case "changed":
      return new SecretServiceError(
        "secret_migration_failed",
        `Ghost refused to migrate ${path} because it changed while being read.`,
      );
    case "encoding":
      return new SecretServiceError("secret_migration_failed", `${path} is not valid UTF-8.`);
  }
}

interface PrivateJsonRead {
  value: unknown;
  identity: PrivateFileIdentity;
}

function privateJson(path: string): PrivateJsonRead {
  let source: ReturnType<typeof readPrivateFile>;
  try {
    source = readPrivateFile(path);
  } catch (error) {
    if (!(error instanceof PrivateReadError)) throw error;
    throw refusedSource(path, error);
  }
  try {
    return { value: JSON.parse(source.text) as unknown, identity: source.identity };
  } catch {
    throw new SecretServiceError("secret_migration_failed", `${path} is not valid JSON.`);
  }
}

function plaintextSourceExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function parseStoredCredential(type: unknown, data: unknown): AuthCredential {
  if ((type !== "api_key" && type !== "oauth") || typeof data !== "string") {
    throw new SecretServiceError("secret_migration_failed", "agent.db contains an invalid credential row.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SecretServiceError("secret_migration_failed", "agent.db contains malformed credential JSON.");
  }
  const record = parsed as Record<string, unknown>;
  if (Object.hasOwn(record, "type")) {
    throw new SecretServiceError("secret_migration_failed", "agent.db contains an invalid credential row.");
  }
  try {
    return validateAuthCredential({ ...record, type });
  } catch {
    throw new SecretServiceError("secret_migration_failed", "agent.db contains an invalid credential row.");
  }
}

interface AgentDbFileClaim {
  originalPath: string;
  claimedPath: string;
  descriptor: number;
  device: bigint;
  inode: bigint;
}

type AgentDbPhase = "claiming" | "claimed" | "committed" | "scrubbing" | "scrubbed";

interface AgentDbEvidenceFile {
  name: string;
  device: string;
  inode: string;
}

interface AgentDbEvidence {
  version: 1;
  phase: AgentDbPhase;
  files: AgentDbEvidenceFile[];
}

interface AgentDbClaim {
  originalPath: string;
  main: AgentDbFileClaim;
  claimDir: string;
  statePath: string;
  evidence: AgentDbEvidence;
  files: AgentDbFileClaim[];
  probe?: GhostSecretMigrationOptions["agentDbProbe"];
  fault?: GhostSecretMigrationOptions["agentDbFault"];
}

class AgentDbAbruptStop extends Error {
  constructor(options?: ErrorOptions) {
    super("Simulated abrupt stop during agent.db migration.", options);
  }
}

function isClaimedAgentDb(
  stats: BigIntStats,
  claim: AgentDbFileClaim,
  links: bigint,
): boolean {
  return stats.isFile()
    && !stats.isSymbolicLink()
    && stats.nlink === links
    && stats.dev === claim.device
    && stats.ino === claim.inode;
}

const AGENT_DB_COMPANION_SUFFIXES = ["-wal", "-shm", "-journal"] as const;
const AGENT_DB_STATE_FILENAME = "state.json";
const AGENT_DB_CLAIM_PREFIX = ".agent-db-";
const AGENT_DB_CLAIM_SUFFIX = ".migration";

function unsafeAgentDb(path: string): SecretServiceError {
  return new SecretServiceError(
    "secret_migration_failed",
    `Ghost refused to migrate unsafe ${path}.`,
  );
}

function missingPath(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function agentDbEvidenceFile(file: AgentDbFileClaim): AgentDbEvidenceFile {
  return {
    name: basename(file.originalPath),
    device: file.device.toString(),
    inode: file.inode.toString(),
  };
}

function writeAgentDbEvidence(claim: AgentDbClaim, phase: AgentDbPhase): void {
  claim.evidence = { ...claim.evidence, phase };
  writePrivateJsonAtomicSync(claim.statePath, claim.evidence);
}

function injectAgentDbFault(
  claim: Pick<AgentDbClaim, "fault">,
  stage: AgentDbFaultStage,
  path: string,
): void {
  if (!claim.fault) return;
  try {
    claim.fault(stage, path);
  } catch (error) {
    throw new AgentDbAbruptStop({ cause: error });
  }
}

function parseAgentDbEvidence(path: string): AgentDbEvidence {
  const parsed = privateJson(path).value as Partial<AgentDbEvidence> | null;
  const phases: readonly AgentDbPhase[] = [
    "claiming",
    "claimed",
    "committed",
    "scrubbing",
    "scrubbed",
  ];
  if (parsed?.version !== 1
    || !phases.includes(parsed.phase as AgentDbPhase)
    || !Array.isArray(parsed.files)
    || parsed.files.length === 0
    || parsed.files.some((file) => !file
      || typeof file.name !== "string"
      || typeof file.device !== "string"
      || typeof file.inode !== "string"
      || !/^agent\.db(?:-(?:wal|shm|journal))?$/.test(file.name)
      || !/^\d+$/.test(file.device)
      || !/^\d+$/.test(file.inode))) {
    throw unsafeAgentDb(path);
  }
  const names = parsed.files.map((file) => file.name);
  if (names[0] !== "agent.db" || new Set(names).size !== names.length) {
    throw unsafeAgentDb(path);
  }
  return parsed as AgentDbEvidence;
}

function pathMatchesEvidence(path: string, evidence: AgentDbEvidenceFile, links: bigint): boolean {
  try {
    const stats = lstatSync(path, { bigint: true });
    return stats.isFile()
      && !stats.isSymbolicLink()
      && stats.nlink === links
      && stats.dev === BigInt(evidence.device)
      && stats.ino === BigInt(evidence.inode);
  } catch {
    return false;
  }
}

function admitAgentDbFile(path: string): AgentDbFileClaim | null {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && missingPath(path)) return null;
    throw unsafeAgentDb(path);
  }
  try {
    const admitted = fstatSync(descriptor, { bigint: true });
    if (!admitted.isFile() || admitted.nlink !== 1n) throw unsafeAgentDb(path);
    return {
      originalPath: path,
      claimedPath: "",
      descriptor,
      device: admitted.dev,
      inode: admitted.ino,
    };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function openAgentDbEvidenceFile(
  originalPath: string,
  claimedPath: string,
  evidence: AgentDbEvidenceFile,
  links = 1n,
): AgentDbFileClaim {
  let descriptor: number;
  try {
    descriptor = openSync(
      claimedPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    throw unsafeAgentDb(originalPath);
  }
  const claim: AgentDbFileClaim = {
    originalPath,
    claimedPath,
    descriptor,
    device: BigInt(evidence.device),
    inode: BigInt(evidence.inode),
  };
  try {
    verifyAgentDbFile(claim, links);
    return claim;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function closeAgentDbClaim(claim: AgentDbClaim): void {
  for (const file of claim.files) closeSync(file.descriptor);
}

function verifyAgentDbFile(claim: AgentDbFileClaim, links = 1n): void {
  let descriptor: BigIntStats;
  let claimed: BigIntStats;
  try {
    descriptor = fstatSync(claim.descriptor, { bigint: true });
    claimed = lstatSync(claim.claimedPath, { bigint: true });
  } catch {
    throw unsafeAgentDb(claim.originalPath);
  }
  if (!isClaimedAgentDb(descriptor, claim, links)
    || !isClaimedAgentDb(claimed, claim, links)) {
    throw unsafeAgentDb(claim.originalPath);
  }
}

function verifyOriginalAgentDbPathsVacant(claim: AgentDbClaim): void {
  for (const file of claim.files) {
    if (!missingPath(file.originalPath)) throw unsafeAgentDb(file.originalPath);
  }
  for (const suffix of AGENT_DB_COMPANION_SUFFIXES) {
    const path = `${claim.originalPath}${suffix}`;
    if (!claim.files.some((file) => file.originalPath === path) && !missingPath(path)) {
      throw unsafeAgentDb(path);
    }
  }
}

function claimAgentDb(
  path: string,
  probe?: GhostSecretMigrationOptions["agentDbProbe"],
  fault?: GhostSecretMigrationOptions["agentDbFault"],
): AgentDbClaim | null {
  const main = admitAgentDbFile(path);
  if (!main) {
    for (const suffix of AGENT_DB_COMPANION_SUFFIXES) {
      if (!missingPath(`${path}${suffix}`)) throw unsafeAgentDb(`${path}${suffix}`);
    }
    return null;
  }
  const files = [main];
  let claimDir = "";
  let claim: AgentDbClaim | undefined;
  try {
    for (const suffix of AGENT_DB_COMPANION_SUFFIXES) {
      const companion = admitAgentDbFile(`${path}${suffix}`);
      if (companion) files.push(companion);
    }
    probe?.("admitted", path);
    claimDir = join(
      dirname(path),
      `${AGENT_DB_CLAIM_PREFIX}${process.pid}-${randomUUID()}${AGENT_DB_CLAIM_SUFFIX}`,
    );
    mkdirSync(claimDir, { mode: 0o700 });
    for (const file of files) {
      file.claimedPath = join(claimDir, basename(file.originalPath));
    }
    claim = {
      originalPath: path,
      main,
      claimDir,
      statePath: join(claimDir, AGENT_DB_STATE_FILENAME),
      evidence: {
        version: 1,
        phase: "claiming",
        files: files.map(agentDbEvidenceFile),
      },
      files,
      ...(probe ? { probe } : {}),
      ...(fault ? { fault } : {}),
    };
    writeAgentDbEvidence(claim, "claiming");
    injectAgentDbFault(claim, "state-written", claim.statePath);
    for (const file of files) {
      renameSync(file.originalPath, file.claimedPath);
      verifyAgentDbFile(file);
      fsyncPath(claimDir);
      fsyncPath(dirname(path));
      injectAgentDbFault(claim, "file-renamed", file.originalPath);
    }
    verifyOriginalAgentDbPathsVacant(claim);
    writeAgentDbEvidence(claim, "claimed");
    injectAgentDbFault(claim, "phase-claimed", claim.statePath);
    fsyncPath(claimDir);
    fsyncPath(dirname(path));
    return claim;
  } catch (error) {
    if (error instanceof AgentDbAbruptStop) {
      for (const file of files) closeSync(file.descriptor);
      throw error;
    }
    for (const file of files.toReversed()) {
      try {
        if (file.claimedPath && missingPath(file.originalPath)) {
          // Even an entry that failed identity verification is the exact path
          // entry this claim moved. Put it back without overwriting a newer
          // arrival; refusing it must not make that replacement disappear.
          linkSync(file.claimedPath, file.originalPath);
          unlinkSync(file.claimedPath);
        }
      } catch {
        // Preserve both paths for explicit recovery rather than overwriting one.
      }
    }
    if (claimDir) {
      try {
        rmSync(join(claimDir, AGENT_DB_STATE_FILENAME), { force: true });
        rmdirSync(claimDir);
      } catch {
        // A non-empty private claim is deliberate recovery evidence.
      }
    }
    for (const file of files) closeSync(file.descriptor);
    throw error;
  }
}

function removePublishedClaimArtifacts(
  claimDir: string,
  statePath: string,
  originalPath: string,
  fault?: GhostSecretMigrationOptions["agentDbFault"],
): void {
  for (const name of readdirSync(claimDir)) {
    const path = join(claimDir, name);
    if (path === statePath) continue;
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) throw unsafeAgentDb(path);
    unlinkSync(path);
    fsyncPath(claimDir);
    injectAgentDbFault({ fault }, "claim-entry-unlinked", path);
  }
  unlinkSync(statePath);
  fsyncPath(claimDir);
  injectAgentDbFault({ fault }, "state-unlinked", statePath);
  rmdirSync(claimDir);
  fsyncPath(dirname(originalPath));
}

function recoverAgentDbClaim(
  path: string,
  probe?: GhostSecretMigrationOptions["agentDbProbe"],
  fault?: GhostSecretMigrationOptions["agentDbFault"],
): AgentDbClaim | null | undefined {
  const parent = dirname(path);
  let names: string[];
  try {
    names = readdirSync(parent)
      .filter((name) => name.startsWith(AGENT_DB_CLAIM_PREFIX)
        && name.endsWith(AGENT_DB_CLAIM_SUFFIX));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const claims: string[] = [];
  for (const name of names) {
    const claimDir = join(parent, name);
    const claimStats = lstatSync(claimDir);
    if (!claimStats.isDirectory()
      || claimStats.isSymbolicLink()
      || (claimStats.mode & 0o777) !== 0o700) {
      throw unsafeAgentDb(claimDir);
    }
    const entries = readdirSync(claimDir);
    if (entries.length === 0) {
      rmdirSync(claimDir);
      fsyncPath(parent);
    } else if (!entries.includes(AGENT_DB_STATE_FILENAME)) {
      const temporaryState = /^state\.json\.\d+\.[0-9a-f-]+\.tmp$/;
      if (!entries.every((entry) => temporaryState.test(entry))) {
        throw unsafeAgentDb(claimDir);
      }
      for (const entry of entries) {
        const temporary = join(claimDir, entry);
        const stats = lstatSync(temporary);
        if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
          throw unsafeAgentDb(temporary);
        }
        unlinkSync(temporary);
      }
      rmdirSync(claimDir);
      fsyncPath(parent);
    } else {
      claims.push(claimDir);
    }
  }
  if (claims.length === 0) return undefined;
  if (claims.length !== 1) throw unsafeAgentDb(path);

  const claimDir = claims[0] as string;
  const statePath = join(claimDir, AGENT_DB_STATE_FILENAME);
  if (missingPath(statePath)) throw unsafeAgentDb(claimDir);
  const evidence = parseAgentDbEvidence(statePath);
  const records = evidence.files.map((file) => ({
    evidence: file,
    originalPath: join(parent, file.name),
    claimedPath: join(claimDir, file.name),
  }));

  if (evidence.phase === "scrubbing") {
    const opened: AgentDbFileClaim[] = [];
    try {
      for (const record of records) {
        if (!missingPath(record.originalPath)) throw unsafeAgentDb(record.originalPath);
        if (record !== records[0] && missingPath(record.claimedPath)) continue;
        opened.push(openAgentDbEvidenceFile(
          record.originalPath,
          record.claimedPath,
          record.evidence,
        ));
      }
      if (opened.length === 0) throw unsafeAgentDb(path);
      return {
        originalPath: path,
        main: opened[0] as AgentDbFileClaim,
        claimDir,
        statePath,
        evidence,
        files: opened,
        ...(probe ? { probe } : {}),
        ...(fault ? { fault } : {}),
      };
    } catch (error) {
      for (const file of opened) closeSync(file.descriptor);
      throw error;
    }
  }

  if (evidence.phase === "scrubbed") {
    const main = records[0] as (typeof records)[number];
    const claimedOne = pathMatchesEvidence(main.claimedPath, main.evidence, 1n);
    const originalOne = pathMatchesEvidence(main.originalPath, main.evidence, 1n);
    const linked = pathMatchesEvidence(main.claimedPath, main.evidence, 2n)
      && pathMatchesEvidence(main.originalPath, main.evidence, 2n);
    for (const record of records.slice(1)) {
      if (!missingPath(record.originalPath)) throw unsafeAgentDb(record.originalPath);
    }
    if (originalOne && missingPath(main.claimedPath)) {
      removePublishedClaimArtifacts(claimDir, statePath, path, fault);
      return null;
    }
    if ((!claimedOne || !missingPath(main.originalPath)) && !linked) {
      throw unsafeAgentDb(path);
    }
    const mainClaim = openAgentDbEvidenceFile(
      main.originalPath,
      main.claimedPath,
      main.evidence,
      linked ? 2n : 1n,
    );
    return {
      originalPath: path,
      main: mainClaim,
      claimDir,
      statePath,
      evidence,
      files: [mainClaim],
      ...(probe ? { probe } : {}),
      ...(fault ? { fault } : {}),
    };
  }

  const opened: AgentDbFileClaim[] = [];
  try {
    for (const record of records) {
      if ((evidence.phase === "claiming" || evidence.phase === "claimed")
        && pathMatchesEvidence(record.originalPath, record.evidence, 1n)
        && missingPath(record.claimedPath)) {
        renameSync(record.originalPath, record.claimedPath);
        fsyncPath(claimDir);
        fsyncPath(parent);
        injectAgentDbFault({ fault }, "file-renamed", record.originalPath);
      }
      if ((evidence.phase === "claiming" || evidence.phase === "claimed")
        && pathMatchesEvidence(record.originalPath, record.evidence, 2n)
        && pathMatchesEvidence(record.claimedPath, record.evidence, 2n)) {
        unlinkSync(record.originalPath);
        fsyncPath(parent);
      }
      if (!missingPath(record.originalPath)) throw unsafeAgentDb(record.originalPath);
      opened.push(openAgentDbEvidenceFile(
        record.originalPath,
        record.claimedPath,
        record.evidence,
      ));
    }
    const claim: AgentDbClaim = {
      originalPath: path,
      main: opened[0] as AgentDbFileClaim,
      claimDir,
      statePath,
      evidence,
      files: opened,
      ...(probe ? { probe } : {}),
      ...(fault ? { fault } : {}),
    };
    if (evidence.phase === "claiming") {
      writeAgentDbEvidence(claim, "claimed");
      injectAgentDbFault(claim, "phase-claimed", statePath);
    }
    return claim;
  } catch (error) {
    for (const file of opened) closeSync(file.descriptor);
    throw error;
  }
}

function recoverOrClaimAgentDb(
  path: string,
  options: GhostSecretMigrationOptions,
): AgentDbClaim | null {
  const recovered = recoverAgentDbClaim(path, options.agentDbProbe, options.agentDbFault);
  return recovered === undefined
    ? claimAgentDb(path, options.agentDbProbe, options.agentDbFault)
    : recovered;
}

function verifyAgentDbClaim(claim: AgentDbClaim): void {
  for (const file of claim.files) verifyAgentDbFile(file);
  verifyOriginalAgentDbPathsVacant(claim);
}

function restoreAgentDbClaim(claim: AgentDbClaim): void {
  if (claim.evidence.phase !== "claimed" && claim.evidence.phase !== "claiming") return;
  try {
    verifyAgentDbClaim(claim);
    for (const file of claim.files) {
      linkSync(file.claimedPath, file.originalPath);
      unlinkSync(file.claimedPath);
    }
    unlinkSync(claim.statePath);
    rmdirSync(claim.claimDir);
    fsyncPath(dirname(claim.originalPath));
  } catch {
    // A replacement is not ours to move or overwrite. Leave the admitted inode
    // at its unique claim path for explicit recovery.
  }
}

function publishAgentDbClaim(claim: AgentDbClaim): void {
  const { main } = claim;
  const alreadyLinked = pathMatchesEvidence(main.claimedPath, agentDbEvidenceFile(main), 2n)
    && pathMatchesEvidence(claim.originalPath, agentDbEvidenceFile(main), 2n);
  if (!alreadyLinked) {
    verifyAgentDbFile(main);
    verifyOriginalAgentDbPathsVacant(claim);
    try {
      // link(2) is the no-replace publication primitive: an adversarial final
      // pathname makes it fail instead of being overwritten by rename(2).
      linkSync(main.claimedPath, claim.originalPath);
    } catch {
      throw unsafeAgentDb(claim.originalPath);
    }
    fsyncPath(dirname(claim.originalPath));
    injectAgentDbFault(claim, "main-linked", claim.originalPath);
  }
  const descriptor = fstatSync(main.descriptor, { bigint: true });
  const claimed = lstatSync(main.claimedPath, { bigint: true });
  const published = lstatSync(claim.originalPath, { bigint: true });
  if (!isClaimedAgentDb(descriptor, main, 2n)
    || !isClaimedAgentDb(claimed, main, 2n)
    || !isClaimedAgentDb(published, main, 2n)) {
    throw unsafeAgentDb(claim.originalPath);
  }
  unlinkSync(main.claimedPath);
  fsyncPath(claim.claimDir);
  injectAgentDbFault(claim, "main-unlinked", main.claimedPath);
  const finalDescriptor = fstatSync(main.descriptor, { bigint: true });
  const finalPath = lstatSync(claim.originalPath, { bigint: true });
  if (!isClaimedAgentDb(finalDescriptor, main, 1n)
    || !isClaimedAgentDb(finalPath, main, 1n)) {
    throw unsafeAgentDb(claim.originalPath);
  }
  removePublishedClaimArtifacts(
    claim.claimDir,
    claim.statePath,
    claim.originalPath,
    claim.fault,
  );
}

/**
 * A row OMP disabled is skipped rather than migrated: the keyring store has no
 * disabled state to carry it into, and the scrub below deletes it with the rest
 * of the file.
 */
function readAgentDb(claim: AgentDbClaim | null): PlainCredentialRow[] {
  if (!claim) return [];
  verifyAgentDbClaim(claim);
  claim.probe?.("opening", claim.originalPath);
  const db = new Database(claim.main.claimedPath, { readonly: true, strict: true });
  try {
    claim.probe?.("claimed", claim.main.claimedPath);
    verifyAgentDbClaim(claim);
    const table = db.query(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_credentials'",
    ).get();
    if (!table) return [];
    const rows = db.query(`
      SELECT provider, credential_type, data
      FROM auth_credentials WHERE disabled_cause IS NULL ORDER BY id
    `).all() as Array<{ provider: unknown; credential_type: unknown; data: unknown }>;
    return rows.map((row) => {
      if (typeof row.provider !== "string" || row.provider.length === 0) {
        throw new SecretServiceError("secret_migration_failed", "agent.db contains an invalid provider id.");
      }
      return { provider: row.provider, credential: parseStoredCredential(row.credential_type, row.data) };
    });
  } finally {
    db.close();
  }
}

interface LegacyCredentialRead {
  rows: PlainCredentialRow[];
  identity: PrivateFileIdentity;
  sha256: string;
  release(): void;
}

function legacyCredentials(path: string): LegacyCredentialRead | null {
  if (!plaintextSourceExists(path)) return null;
  let source: ReturnType<typeof readPrivateFilePinned>;
  try {
    source = readPrivateFilePinned(path);
  } catch (error) {
    if (!(error instanceof PrivateReadError)) throw error;
    throw refusedSource(path, error);
  }
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source.text) as unknown;
    } catch {
      throw new SecretServiceError("secret_migration_failed", `${path} is not valid JSON.`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SecretServiceError("secret_migration_failed", `${path} must contain a credential object.`);
    }
    const rows: PlainCredentialRow[] = [];
    for (const [provider, value] of Object.entries(parsed)) {
      const entries = Array.isArray(value) ? value : [value];
      for (const entry of entries) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new SecretServiceError("secret_migration_failed", `${path} contains an invalid credential.`);
        }
        try {
          rows.push({ provider, credential: validateAuthCredential(entry) });
        } catch {
          throw new SecretServiceError("secret_migration_failed", `${path} contains an invalid credential.`);
        }
      }
    }
    return {
      rows,
      identity: source.identity,
      sha256: source.sha256,
      release: source.release,
    };
  } catch (error) {
    source.release();
    throw error;
  }
}

function fieldToken(value: string): string {
  const encoded = Buffer.from(value, "utf8").toString("base64url");
  return encoded.length <= 160
    ? encoded
    : `sha256-${createHash("sha256").update(value).digest("hex")}`;
}

function modelsHeaderField(name: string): string {
  return `models.header.${fieldToken(name)}`;
}

/**
 * Every provider field that may hold a credential, in a stable order, rewritten
 * in place with whatever the visitor returns.
 *
 * Planning, conversion, and connection-time resolution all drive this one walk,
 * for the same reason the MCP walk below does: a field only one of them knew
 * about would either keep a plaintext secret on disk or hand a provider the
 * reference text instead of the credential. Deriving the envelope field here
 * also keeps the account chosen for a header the account it is written into.
 */
export function visitProviderSecretFields(
  config: GhostProviderConfig,
  visit: (value: string, field: string, purpose: string) => string,
): void {
  if (typeof config.apiKey === "string") {
    config.apiKey = visit(config.apiKey, DEFAULT_SECRET_FIELD, "models.apiKey");
  }
  if (config.headers) {
    for (const [name, value] of Object.entries(config.headers)) {
      config.headers[name] = visit(value, modelsHeaderField(name), "models.header");
    }
  }
}

function mcpSecretService(serverName: string): string {
  const slug = serverName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72)
    || "server";
  const digest = createHash("sha256").update(serverName).digest("hex").slice(0, 12);
  return `mcp.${slug}.${digest}`;
}

function sensitiveUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(
      url.username
      || url.password
      || url.hash.length > 1
      || /(?:^|\/)(?:api[-_]?key|auth|bearer|credential|password|secret|token)(?:\/|=|:)/i
        .test(url.pathname)
      || [...url.searchParams.keys()].some((key) => SENSITIVE_NAME.test(key)),
    );
  } catch {
    return false;
  }
}

function sensitiveCommandArgument(args: readonly string[], index: number): boolean {
  const value = args[index] as string;
  const previous = index > 0 ? args[index - 1] : undefined;
  const equals = value.indexOf("=");
  const flag = equals > 0 ? value.slice(0, equals) : value;
  return (equals > 0 && SENSITIVE_NAME.test(flag))
    || (typeof previous === "string" && SENSITIVE_NAME.test(previous))
    || SENSITIVE_ARGUMENT_VALUE.test(value)
    || sensitiveUrl(value);
}

function storeLiteral(
  context: GhostSecretContext,
  account: SecretAccountRef,
  field: string,
  value: string,
  purpose: string,
  addedAccounts: Set<string>,
): string {
  const ref = { ...account, field };
  context.putField(ref, value, purpose);
  const accountName = secretAccountName(account);
  addedAccounts.add(accountName);
  context.allowAccounts([accountName]);
  return formatSecretReference(ref, field);
}

function migrateModels(
  models: GhostModelsFile,
  context: GhostSecretContext,
  addedAccounts: Set<string>,
): boolean {
  let changed = false;
  const allowed = new Set(models.accounts ?? []);
  for (const [provider, config] of Object.entries(models.providers)) {
    const service = serviceForCredentialProvider(provider);
    const planned: Record<string, string> = {};
    visitProviderSecretFields(config, (value, field) => {
      if (!isSecretReference(value)) planned[field] = value;
      return value;
    });
    const plannedApiKey = planned[DEFAULT_SECRET_FIELD];
    const account = context.selectLiteralAccount(service, planned, {
      ...(plannedApiKey === undefined ? {} : { apiKey: plannedApiKey }),
    });
    try {
      visitProviderSecretFields(config, (value, field, purpose) => {
        if (isSecretReference(value)) {
          authorizedSecretReference(value, allowed);
          return value;
        }
        const reference = storeLiteral(context, account, field, value, purpose, addedAccounts);
        changed = true;
        return reference;
      });
    } finally {
      context.releaseLiteralAccount(account);
    }
  }
  return changed;
}

/**
 * Every MCP field that may hold a credential, in a stable order, rewritten in
 * place with whatever the visitor returns. `capture` is this traversal's own
 * judgement that a literal there is a secret; a value already written as a
 * reference is offered whatever that judgement is, because an unauthorized
 * reference is refused wherever it appears.
 *
 * Planning, conversion, and connection-time resolution all drive this one walk.
 * A field only one of them knew about would either keep a plaintext secret on
 * disk or hand an MCP server the reference text instead of the credential.
 */
export function visitMcpSecretFields(
  config: MCPServerConfig & Record<string, unknown>,
  visit: (value: string, field: string, purpose: string, capture: boolean) => string,
): void {
  if ((config.type ?? "stdio") === "stdio") {
    const stdio = config as MCPServerConfig & { args?: string[]; env?: Record<string, string> };
    if (stdio.env) {
      for (const [key, value] of Object.entries(stdio.env)) {
        stdio.env[key] = visit(value, `env.${fieldToken(key)}`, "mcp.env", true);
      }
    }
    if (stdio.args) {
      for (let index = 0; index < stdio.args.length; index += 1) {
        const value = stdio.args[index] as string;
        const capture = sensitiveCommandArgument(stdio.args, index);
        stdio.args[index] = visit(value, `arg.${index}`, "mcp.argument", capture);
      }
    }
  } else {
    const remote = config as MCPServerConfig & { url: string; headers?: Record<string, string> };
    if (remote.headers) {
      for (const [key, value] of Object.entries(remote.headers)) {
        remote.headers[key] = visit(value, `header.${fieldToken(key)}`, "mcp.header", true);
      }
    }
    remote.url = visit(remote.url, "url", "mcp.url", sensitiveUrl(remote.url));
  }
  const auth = config.auth as (Record<string, unknown> & { clientSecret?: string }) | undefined;
  if (typeof auth?.clientSecret === "string") {
    auth.clientSecret = visit(auth.clientSecret, "auth.clientSecret", "mcp.client-secret", true);
  }
  const oauth = config.oauth as (Record<string, unknown> & { clientSecret?: string }) | undefined;
  if (typeof oauth?.clientSecret === "string") {
    oauth.clientSecret = visit(oauth.clientSecret, "oauth.clientSecret", "mcp.client-secret", true);
  }
}

export function materializeMcpSecretReferences(
  serverName: string,
  input: MCPServerConfig,
  context: GhostSecretContext,
): { config: MCPServerConfig; addedAccounts: string[] } {
  const config = structuredClone(input) as MCPServerConfig & Record<string, unknown>;
  const added = new Set<string>();
  const allowed = context.allowedAccounts;

  // The account is chosen from everything this row wants to store, so the whole
  // row is planned before any of it is written.
  const planned: Record<string, string> = {};
  visitMcpSecretFields(config, (value, field, _purpose, capture) => {
    if (value.startsWith(SECRET_REFERENCE_PREFIX)) authorizedSecretReference(value, allowed);
    else if (capture) planned[field] = value;
    return value;
  });

  const account = context.selectLiteralAccount(mcpSecretService(serverName), planned);
  try {
    visitMcpSecretFields(config, (value, field, purpose, capture) => {
      if (value.startsWith(SECRET_REFERENCE_PREFIX)) {
        authorizedSecretReference(value, allowed);
        return value;
      }
      if (!capture) return value;
      return storeLiteral(context, account, field, value, purpose, added);
    });
    return { config, addedAccounts: [...added] };
  } finally {
    context.releaseLiteralAccount(account);
  }
}

function migrateMcpFile(
  home: string,
  context: GhostSecretContext,
): {
  document: McpConfigDocument | null;
  identity: PrivateFileIdentity | null;
  changed: boolean;
  addedAccounts: string[];
} {
  const path = join(home, MCP_FILENAME);
  if (!plaintextSourceExists(path)) {
    return { document: null, identity: null, changed: false, addedAccounts: [] };
  }
  const source = privateJson(path);
  const parsed = source.value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SecretServiceError("secret_migration_failed", `${path} must contain a JSON object.`);
  }
  const document = parsed as McpConfigDocument;
  if (document.mcpServers !== undefined
    && (!document.mcpServers || typeof document.mcpServers !== "object" || Array.isArray(document.mcpServers))) {
    throw new SecretServiceError("secret_migration_failed", `${path} "mcpServers" must be an object.`);
  }
  let changed = false;
  const accounts = new Set<string>();
  for (const [name, value] of Object.entries(document.mcpServers ?? {})) {
    // A row the MCP catalogue itself rejects is left exactly as written. Its
    // taxonomy already owns that case (`invalid_mcp_server`/`skipped`), and a
    // neighbour's typo is not the fail-closed condition this migration exists
    // for: that is the keyring being locked or absent. Any secret such a row
    // still holds stays plaintext and visibly invalid until the owner fixes
    // the row, and the next open migrates it.
    if (mcpServerValidationErrors(name, value).length > 0) continue;
    const migrated = materializeMcpSecretReferences(name, value as MCPServerConfig, context);
    if (JSON.stringify(migrated.config) !== JSON.stringify(value)) {
      (document.mcpServers as Record<string, unknown>)[name] = migrated.config;
      changed = true;
    }
    for (const account of migrated.addedAccounts) accounts.add(account);
  }
  return { document, identity: source.identity, changed, addedAccounts: [...accounts] };
}

function importCredentials(
  rows: readonly PlainCredentialRow[],
  context: GhostSecretContext,
  accounts: Set<string>,
): void {
  for (const row of rows) {
    const existing = context.findCredentialReference(row.provider, row.credential);
    if (existing) {
      accounts.add(secretAccountName(existing));
      continue;
    }
    const account = context.selectLiteralAccount(
      serviceForCredentialProvider(row.provider),
      {},
      { credential: row.credential },
    );
    try {
      context.registerCredential(row.provider, { ...account, field: "auth" }, row.credential);
      accounts.add(secretAccountName(account));
    } finally {
      context.releaseLiteralAccount(account);
    }
  }
}

/** What the file is, rather than whose it was: schema number and change counter. */
const AGENT_DB_SCHEMA_TABLES = new Set(["auth_schema_version", "auth_change_revision"]);

/**
 * Empty the legacy database down to those two rows.
 *
 * The keep-list is a list of what stays, not of what goes, on purpose: naming
 * the credential tables left the identity sitting beside them, and nothing
 * creates or reads `agent.db` after migration — the injected credential store
 * bypasses it entirely — so deleting every table not named here covers whatever
 * OMP adds later by default.
 */
function scrubAgentDb(claim: AgentDbClaim | null): void {
  if (!claim) return;
  verifyAgentDbFile(claim.main);
  verifyOriginalAgentDbPathsVacant(claim);
  const db = new Database(claim.main.claimedPath, { create: false, strict: true });
  try {
    claim.probe?.("scrubbing", claim.main.claimedPath);
    verifyAgentDbFile(claim.main);
    verifyOriginalAgentDbPathsVacant(claim);
    const rows = db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tables = rows
      .map((row) => row.name)
      .filter((name) => !name.startsWith("sqlite_") && !AGENT_DB_SCHEMA_TABLES.has(name));
    if (tables.length > 0) {
      db.exec("PRAGMA journal_mode = DELETE");
      db.transaction(() => {
        for (const name of tables) db.exec(`DELETE FROM "${name.replaceAll('"', '""')}"`);
      }).exclusive();
      db.exec("VACUUM");
    }
  } finally {
    db.close();
  }
  claim.probe?.("scrubbed", claim.main.claimedPath);
  verifyAgentDbFile(claim.main);
  verifyOriginalAgentDbPathsVacant(claim);
  fsyncPath(claim.main.claimedPath);
  verifyAgentDbFile(claim.main);
}

function changedPlaintextSource(path: string): SecretServiceError {
  return new SecretServiceError(
    "secret_migration_failed",
    `Ghost refused to remove changed plaintext source ${path}.`,
  );
}

type PlainRemovalPhase = "prepared" | "anchored" | "claimed";

interface PlainRemovalEvidence {
  version: 2;
  phase: PlainRemovalPhase;
  originalName: string;
  claimName: string;
  anchorName: string;
  device: string;
  inode: string;
  sha256: string;
}

interface PlainRemovalClaim {
  path: string;
  claimedPath: string;
  anchorPath: string;
  statePath: string;
  evidence: PlainRemovalEvidence;
  fault?: GhostSecretMigrationOptions["plainFileFault"];
}

class PlainFileAbruptStop extends Error {
  constructor(options?: ErrorOptions) {
    super("Simulated abrupt stop during plaintext removal.", options);
  }
}

const PLAIN_REMOVAL_SUFFIX = ".removal";
const PLAIN_REMOVAL_STATE_SUFFIX = ".state.json";

function injectPlainFileFault(
  claim: Pick<PlainRemovalClaim, "fault" | "path">,
  stage: PlainFileFaultStage,
): void {
  if (!claim.fault) return;
  try {
    claim.fault(stage, claim.path);
  } catch (cause) {
    throw new PlainFileAbruptStop({ cause });
  }
}

function pinPlainRemoval(
  path: string,
  evidence: PlainRemovalEvidence,
  links: bigint,
): ReturnType<typeof readPrivateFilePinned> | null {
  let source: ReturnType<typeof readPrivateFilePinned>;
  try {
    source = readPrivateFilePinned(path, { links });
  } catch {
    return null;
  }
  if (source.identity.device !== BigInt(evidence.device)
    || source.identity.inode !== BigInt(evidence.inode)
    || source.sha256 !== evidence.sha256) {
    source.release();
    return null;
  }
  return source;
}

function plainRemovalMatches(
  path: string,
  evidence: PlainRemovalEvidence,
  links: bigint,
): boolean {
  const source = pinPlainRemoval(path, evidence, links);
  if (!source) return false;
  source.release();
  return true;
}

function sameTwoLinkPlainRemoval(left: string, right: string): boolean {
  try {
    const first = lstatSync(left, { bigint: true });
    const second = lstatSync(right, { bigint: true });
    return first.isFile()
      && !first.isSymbolicLink()
      && first.nlink === 2n
      && second.isFile()
      && !second.isSymbolicLink()
      && second.nlink === 2n
      && first.dev === second.dev
      && first.ino === second.ino;
  } catch {
    return false;
  }
}

function writePlainRemovalEvidence(claim: PlainRemovalClaim, phase: PlainRemovalPhase): void {
  claim.evidence = { ...claim.evidence, phase };
  writePrivateJsonAtomicSync(claim.statePath, claim.evidence);
}

function finishPlainRemovalEvidence(claim: PlainRemovalClaim): void {
  unlinkSync(claim.statePath);
  fsyncPath(dirname(claim.path));
  injectPlainFileFault(claim, "state-unlinked");
}

function parsePlainRemovalEvidence(path: string, statePath: string): PlainRemovalEvidence {
  const parsed = privateJson(statePath).value as Partial<PlainRemovalEvidence> | null;
  const originalName = basename(path);
  if (parsed?.version !== 2
    || (parsed.phase !== "prepared" && parsed.phase !== "anchored" && parsed.phase !== "claimed")
    || parsed.originalName !== originalName
    || typeof parsed.claimName !== "string"
    || parsed.claimName.length > 255
    || !parsed.claimName.startsWith(`${originalName}.`)
    || !parsed.claimName.endsWith(PLAIN_REMOVAL_SUFFIX)
    || basename(parsed.claimName) !== parsed.claimName
    || parsed.anchorName !== `${parsed.claimName}.anchor`
    || basename(parsed.anchorName) !== parsed.anchorName
    || basename(statePath) !== `${parsed.claimName}${PLAIN_REMOVAL_STATE_SUFFIX}`
    || typeof parsed.device !== "string"
    || typeof parsed.inode !== "string"
    || !/^\d+$/.test(parsed.device)
    || !/^\d+$/.test(parsed.inode)
    || typeof parsed.sha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(parsed.sha256)) {
    throw changedPlaintextSource(path);
  }
  return parsed as PlainRemovalEvidence;
}

function unlinkAdmittedPlainPath(
  claim: PlainRemovalClaim,
  path: string,
  links: bigint,
): void {
  const pinned = pinPlainRemoval(path, claim.evidence, links);
  if (!pinned) throw changedPlaintextSource(claim.path);
  try {
    unlinkSync(path);
    fsyncPath(dirname(claim.path));
  } finally {
    pinned.release();
  }
}

function retirePlainRemovalAnchor(claim: PlainRemovalClaim): void {
  unlinkAdmittedPlainPath(claim, claim.anchorPath, 1n);
  injectPlainFileFault(claim, "anchor-unlinked");
  finishPlainRemovalEvidence(claim);
}

function restoreUnadmittedPlainRemoval(claim: PlainRemovalClaim): void {
  if (!missingPath(claim.path)) throw changedPlaintextSource(claim.path);
  try {
    linkSync(claim.claimedPath, claim.path);
    fsyncPath(dirname(claim.path));
    injectPlainFileFault(claim, "replacement-linked");
    if (!sameTwoLinkPlainRemoval(claim.claimedPath, claim.path)) {
      throw changedPlaintextSource(claim.path);
    }
    unlinkSync(claim.claimedPath);
    fsyncPath(dirname(claim.path));
    injectPlainFileFault(claim, "claim-unlinked");
    retirePlainRemovalAnchor(claim);
  } catch (error) {
    if (error instanceof PlainFileAbruptStop) throw error;
    if (error instanceof SecretServiceError) throw error;
    throw changedPlaintextSource(claim.path);
  }
}

function reconcilePlainRemoval(claim: PlainRemovalClaim, recovering: boolean): void {
  if (claim.evidence.phase === "prepared") {
    if (missingPath(claim.anchorPath)) {
      if (!missingPath(claim.claimedPath)) throw changedPlaintextSource(claim.path);
      finishPlainRemovalEvidence(claim);
      return;
    }
    if (!plainRemovalMatches(claim.anchorPath, claim.evidence, 1n)
      && !plainRemovalMatches(claim.anchorPath, claim.evidence, 2n)) {
      throw changedPlaintextSource(claim.path);
    }
    writePlainRemovalEvidence(claim, "anchored");
    injectPlainFileFault(claim, "phase-anchored");
  }

  if (missingPath(claim.anchorPath)) {
    if (claim.evidence.phase === "claimed" && missingPath(claim.claimedPath)) {
      finishPlainRemovalEvidence(claim);
      return;
    }
    throw changedPlaintextSource(claim.path);
  }

  // Restoring an unadmitted replacement stopped between link and unlink. Its
  // public name already owns that exact inode; the separate anchor still pins
  // the admitted source while the no-replace move is finished.
  if (sameTwoLinkPlainRemoval(claim.claimedPath, claim.path)) {
    if (!plainRemovalMatches(claim.anchorPath, claim.evidence, 1n)) {
      throw changedPlaintextSource(claim.path);
    }
    if (claim.evidence.phase !== "claimed") {
      writePlainRemovalEvidence(claim, "claimed");
      injectPlainFileFault(claim, "phase-claimed");
    }
    unlinkSync(claim.claimedPath);
    fsyncPath(dirname(claim.path));
    injectPlainFileFault(claim, "claim-unlinked");
    retirePlainRemovalAnchor(claim);
    if (!recovering) throw changedPlaintextSource(claim.path);
    return;
  }

  if (!missingPath(claim.claimedPath)) {
    const admittedClaim = sameTwoLinkPlainRemoval(claim.anchorPath, claim.claimedPath)
      && plainRemovalMatches(claim.claimedPath, claim.evidence, 2n);
    if (!admittedClaim) {
      if (!plainRemovalMatches(claim.anchorPath, claim.evidence, 1n)) {
        throw changedPlaintextSource(claim.path);
      }
      if (claim.evidence.phase !== "claimed") {
        writePlainRemovalEvidence(claim, "claimed");
        injectPlainFileFault(claim, "phase-claimed");
      }
      restoreUnadmittedPlainRemoval(claim);
      if (!recovering) throw changedPlaintextSource(claim.path);
      return;
    }
    if (claim.evidence.phase !== "claimed") {
      writePlainRemovalEvidence(claim, "claimed");
      injectPlainFileFault(claim, "phase-claimed");
    }
    const replacementWon = !missingPath(claim.path);
    unlinkAdmittedPlainPath(claim, claim.claimedPath, 2n);
    injectPlainFileFault(claim, "claim-unlinked");
    retirePlainRemovalAnchor(claim);
    if (replacementWon && !recovering) throw changedPlaintextSource(claim.path);
    return;
  }

  if (claim.evidence.phase === "anchored"
    && sameTwoLinkPlainRemoval(claim.anchorPath, claim.path)
    && plainRemovalMatches(claim.path, claim.evidence, 2n)) {
    try {
      renameSync(claim.path, claim.claimedPath);
      fsyncPath(dirname(claim.path));
    } catch {
      throw changedPlaintextSource(claim.path);
    }
    injectPlainFileFault(claim, "file-renamed");
    reconcilePlainRemoval(claim, recovering);
    return;
  }

  if (!plainRemovalMatches(claim.anchorPath, claim.evidence, 1n)) {
    throw changedPlaintextSource(claim.path);
  }
  const replacementWon = !missingPath(claim.path);
  if (claim.evidence.phase !== "claimed") {
    writePlainRemovalEvidence(claim, "claimed");
    injectPlainFileFault(claim, "phase-claimed");
  }
  retirePlainRemovalAnchor(claim);
  if (replacementWon && !recovering) throw changedPlaintextSource(claim.path);
}

function recoverPlainFileRemovals(
  path: string,
  fault?: GhostSecretMigrationOptions["plainFileFault"],
): void {
  const directory = dirname(path);
  const prefix = `${basename(path)}.`;
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const states = names.filter((name) =>
    name.startsWith(prefix)
      && name.endsWith(`${PLAIN_REMOVAL_SUFFIX}${PLAIN_REMOVAL_STATE_SUFFIX}`));
  if (states.length > 1) throw changedPlaintextSource(path);
  const stateName = states[0];
  if (!stateName) return;
  const statePath = join(directory, stateName);
  const evidence = parsePlainRemovalEvidence(path, statePath);
  reconcilePlainRemoval({
    path,
    claimedPath: join(directory, evidence.claimName),
    anchorPath: join(directory, evidence.anchorName),
    statePath,
    evidence,
    ...(fault ? { fault } : {}),
  }, true);
}

function removePlainFile(
  path: string,
  identity: PrivateFileIdentity,
  sha256: string,
  fault?: GhostSecretMigrationOptions["plainFileFault"],
): void {
  const claimName = `${basename(path)}.${process.pid}-${randomUUID()}${PLAIN_REMOVAL_SUFFIX}`;
  const anchorName = `${claimName}.anchor`;
  const claimedPath = join(dirname(path), claimName);
  const anchorPath = join(dirname(path), anchorName);
  const statePath = `${claimedPath}${PLAIN_REMOVAL_STATE_SUFFIX}`;
  const claim: PlainRemovalClaim = {
    path,
    claimedPath,
    anchorPath,
    statePath,
    evidence: {
      version: 2,
      phase: "prepared",
      originalName: basename(path),
      claimName,
      anchorName,
      device: identity.device.toString(),
      inode: identity.inode.toString(),
      sha256,
    },
    ...(fault ? { fault } : {}),
  };
  writePlainRemovalEvidence(claim, "prepared");
  injectPlainFileFault(claim, "state-written");
  try {
    linkSync(path, anchorPath);
  } catch {
    finishPlainRemovalEvidence(claim);
    throw changedPlaintextSource(path);
  }
  fsyncPath(dirname(path));
  injectPlainFileFault(claim, "anchor-linked");
  if (!sameTwoLinkPlainRemoval(anchorPath, path)) {
    throw changedPlaintextSource(path);
  }
  if (!plainRemovalMatches(anchorPath, claim.evidence, 2n)) {
    unlinkSync(anchorPath);
    fsyncPath(dirname(path));
    finishPlainRemovalEvidence(claim);
    throw changedPlaintextSource(path);
  }
  writePlainRemovalEvidence(claim, "anchored");
  injectPlainFileFault(claim, "phase-anchored");
  reconcilePlainRemoval(claim, false);
}

/**
 * Whether the `.pi` directory still holds anything the one-time retirement
 * machinery exists for: a legacy `auth.json` or `agent.db` (with companions),
 * an interrupted migration claim, or plain-removal evidence. One readdir; a
 * home that never had the artifacts answers false forever.
 */
function legacySecretArtifactsPresent(authPath: string): boolean {
  let names: string[];
  try {
    names = readdirSync(dirname(authPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const authName = basename(authPath);
  return names.some((name) =>
    name === authName
    || name === "agent.db"
    || AGENT_DB_COMPANION_SUFFIXES.some((suffix) => name === `agent.db${suffix}`)
    || name.startsWith(AGENT_DB_CLAIM_PREFIX)
    || (name.startsWith(`${authName}.`) && name.includes(PLAIN_REMOVAL_SUFFIX)));
}

/**
 * The live half of every open: authorize the accounts models.json names and
 * materialize plaintext secrets found in models.json/mcp.json into keyring
 * references, under the same locks every other writer takes.
 */
function materializeLiveReferences(
  options: GhostSecretMigrationOptions,
  context: GhostSecretContext,
  addedAccounts: Set<string>,
): void {
  const mcpPath = join(options.home, MCP_FILENAME);
  withMCPConfigWriteLock(mcpPath, () => {
    const modelsPath = ghostModelsPath(options.home);
    const mcp = withSerializedModelsWrite(modelsPath, () => {
      const snapshot = readGhostModelsSnapshot(options.home);
      const models = snapshot?.file ?? { providers: {} };
      context.allowAccounts(models.accounts ?? []);
      const migratedMcp = migrateMcpFile(options.home, context);
      for (const account of migratedMcp.addedAccounts) addedAccounts.add(account);
      const modelsChanged = migrateModels(models, context, addedAccounts);
      const previousAccounts = models.accounts ?? [];
      const mergedAccounts = [...new Set([...previousAccounts, ...addedAccounts])];
      if (mergedAccounts.length > 0) models.accounts = mergedAccounts;
      context.allowAccounts(mergedAccounts);
      if (modelsChanged || mergedAccounts.length !== previousAccounts.length) {
        options.portableCommitProbe?.("models", modelsPath);
        writePrivateJsonAtomicCas(modelsPath, models, snapshot?.identity ?? null);
      }
      return migratedMcp;
    });
    // Accounts are durable policy before the config can publish references
    // to them; a failed MCP CAS leaves only harmless extra authorization.
    if (mcp.changed && mcp.document) {
      options.portableCommitProbe?.("mcp", mcpPath);
      writePrivateJsonAtomicCas(mcpPath, mcp.document, mcp.identity);
    }
  });
}

function migrateWithContext(
  options: GhostSecretMigrationOptions,
  context: GhostSecretContext,
): void {
  const authPath = options.authPath ?? join(options.home, ".pi", "auth.json");
  if (!legacySecretArtifactsPresent(authPath)) {
    materializeLiveReferences(options, context, new Set());
    return;
  }
  recoverPlainFileRemovals(authPath, options.plainFileFault);
  const agentDb = join(dirname(authPath), "agent.db");
  const agentDbClaim = recoverOrClaimAgentDb(agentDb, options);
  let agentDbPublished = false;
  let legacy: LegacyCredentialRead | null = null;
  try {
    const addedAccounts = new Set<string>();
    const database = agentDbClaim?.evidence.phase === "claimed"
      ? readAgentDb(agentDbClaim)
      : [];
    legacy = legacyCredentials(authPath);
    importCredentials([...database, ...(legacy?.rows ?? [])], context, addedAccounts);

    materializeLiveReferences(options, context, addedAccounts);

    // Plaintext is removed only after every keyring write was read back and
    // both portable config replacements are durable. Every preceding step is
    // idempotent, so a crash is resumed from the surviving source.
    if (agentDbClaim) {
      if (agentDbClaim.evidence.phase === "claimed") {
        writeAgentDbEvidence(agentDbClaim, "committed");
        injectAgentDbFault(agentDbClaim, "phase-committed", agentDbClaim.statePath);
      }
      if (agentDbClaim.evidence.phase === "committed") {
        verifyAgentDbClaim(agentDbClaim);
        writeAgentDbEvidence(agentDbClaim, "scrubbing");
        injectAgentDbFault(agentDbClaim, "phase-scrubbing", agentDbClaim.statePath);
      }
      if (agentDbClaim.evidence.phase === "scrubbing") {
        scrubAgentDb(agentDbClaim);
        writeAgentDbEvidence(agentDbClaim, "scrubbed");
        injectAgentDbFault(agentDbClaim, "phase-scrubbed", agentDbClaim.statePath);
      }
      publishAgentDbClaim(agentDbClaim);
      agentDbPublished = true;
    }
    if (legacy) {
      options.plainFileProbe?.("removing", authPath);
      removePlainFile(authPath, legacy.identity, legacy.sha256, options.plainFileFault);
    }
  } catch (error) {
    if (agentDbClaim && !agentDbPublished && !(error instanceof AgentDbAbruptStop)) {
      restoreAgentDbClaim(agentDbClaim);
    }
    throw error;
  } finally {
    legacy?.release();
    if (agentDbClaim) closeAgentDbClaim(agentDbClaim);
  }
}

export function openGhostSecretContext(options: GhostSecretMigrationOptions): GhostSecretContext {
  const context = new GhostSecretContext({
    allowedAccounts: [],
    ...(options.client ? { client: options.client } : {}),
    ...(options.metadataPath ? { metadataPath: options.metadataPath } : {}),
  });
  try {
    context.withMigrationLease(options.home, () => migrateWithContext(options, context));
    return context;
  } catch (error) {
    context.close();
    if (error instanceof SecretServiceError) throw error;
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new SecretServiceError(
      "secret_migration_failed",
      `Ghost stopped the keyring migration safely; no plaintext source was removed before its verified replacement.${detail}`,
    );
  }
}

export function authorizeGhostAccounts(home: string, context: GhostSecretContext, accounts: readonly string[]): void {
  if (accounts.length === 0) return;
  addGhostAccounts(home, accounts);
  context.allowAccounts(accounts);
}
