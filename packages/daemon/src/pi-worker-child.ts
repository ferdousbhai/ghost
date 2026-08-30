import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type LoadExtensionsResult,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { scrubProviderEnv } from "./env-scrub.js";
import { ghostPaths, isGhostHome } from "./ghosts.js";
import { machineSkillPaths } from "./machine-skills.js";
import { resolveChatModel } from "./model-routing.js";
import { readGhostModels, resolveChatModelRef } from "./models.js";
import {
  encodePiWorkerLine,
  parsePiWorkerCommand,
  parsePiWorkerLine,
  PI_WORKER_MAX_ERROR_TEXT,
  PI_WORKER_MAX_EVENT_TEXT,
  PI_WORKER_MAX_RESULT_TEXT,
  PI_WORKER_PROTOCOL_VERSION,
  type PiWorkerEvent,
  type PiWorkerStartCommand,
} from "./pi-worker-protocol.js";
import { createGhostPiRuntime, type GhostPiRuntime } from "./pi-runtime.js";
import { isTaskId } from "./tasks.js";

export const PI_WORKER_TOOL_NAMES = [
  "bash",
  "edit",
  "find",
  "grep",
  "ls",
  "read",
  "write",
] as const;

export const PI_WORKER_SYSTEM_PROMPT = [
  "## Delegated worker role",
  "You are pi-worker, a coding worker responsible for the task delegated by Ghost.",
  "You are not the owner's Ghost or digital persona. Follow the project's instructions and skills, work directly in the current project, verify the result, and report the outcome to Ghost.",
  "Do not modify Ghost persona, memory, or runtime documents unless the delegated task explicitly targets those files.",
].join("\n");

interface PiWorkerExecutionResult {
  text: string;
}

interface PiWorkerDiagnostic {
  type: "error" | "info" | "warning";
  message: string;
}

interface ExtensionFailureState {
  error?: Error;
}

export interface PiWorkerChildSession {
  readonly sessionId: string;
  run(task: string): Promise<PiWorkerExecutionResult>;
  send(text: string): Promise<void>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}

export interface PiWorkerChildDependencies {
  createSession?: (
    input: PiWorkerStartCommand,
    emit: (event: PiWorkerEvent) => void,
  ) => Promise<PiWorkerChildSession>;
  emit(event: PiWorkerEvent): void;
}

export interface NativePiWorkerSessionOptions {
  /** Owner root whose explicit machine-skill directories are admitted. */
  ownerHome?: string;
}

function isWithin(root: string, cwd: string): boolean {
  const relation = relative(root, cwd);
  return relation === ""
    || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum);
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Pi worker transcript directory is unsafe: ${path}`);
  }
}

class ProtectedToolMap<V> extends Map<string, V> {
  constructor(entries: Iterable<readonly [string, V]>, private readonly protectedNames: Set<string>) {
    super();
    for (const [name, value] of entries) {
      if (!protectedNames.has(name)) super.set(name, value);
    }
  }

  override set(name: string, value: V): this {
    if (!this.protectedNames.has(name)) super.set(name, value);
    return this;
  }
}

/** Preserve extension lifecycle while preventing project tools from replacing bundled worker tools. */
export function protectPiWorkerTools(result: LoadExtensionsResult): LoadExtensionsResult {
  const protectedNames = new Set<string>(PI_WORKER_TOOL_NAMES);
  for (const extension of result.extensions) {
    extension.tools = new ProtectedToolMap(extension.tools, protectedNames);
  }
  return result;
}

function canonicalPathWithin(path: string, roots: readonly string[]): boolean {
  try {
    const canonical = realpathSync(path);
    return roots.some((root) => isWithin(root, canonical));
  } catch {
    return false;
  }
}

/** Remove Pi's ambient ancestor skills while retaining the pinned project and explicit machine roots. */
export function restrictPiWorkerSkills<T extends {
  skills: Skill[];
  diagnostics: Array<{ path?: string }>;
}>(
  base: T,
  roots: readonly string[],
): T {
  return {
    ...base,
    skills: base.skills.filter((skill) => canonicalPathWithin(skill.filePath, roots)),
    diagnostics: base.diagnostics.filter((diagnostic) =>
      !diagnostic.path || canonicalPathWithin(diagnostic.path, roots)),
  } as T;
}

function settingsDiagnostics(settingsManager: SettingsManager): PiWorkerDiagnostic[] {
  return settingsManager.drainErrors().map(({ scope, path, error }) => ({
    type: "warning",
    message: path
      ? `Invalid settings file ${path}: ${error.message}`
      : `Invalid ${scope} settings: ${error.message}`,
  }));
}

function assistantFailure(session: AgentSessionRuntime): Error | null {
  const message = session.session.state.messages.at(-1);
  if (message?.role !== "assistant") return null;
  const assistant = message as typeof message & { stopReason?: string; errorMessage?: string };
  if (assistant.stopReason !== "error" && assistant.stopReason !== "aborted") return null;
  return new Error(assistant.errorMessage || `Pi worker request ${assistant.stopReason}.`);
}

class NativePiWorkerSession implements PiWorkerChildSession {
  private disposed = false;
  private finished = false;
  private controls = Promise.resolve();

  constructor(
    private readonly runtimeHost: AgentSessionRuntime,
    private readonly modelRuntime: GhostPiRuntime,
    private readonly unsubscribe: () => void,
    private readonly extensionFailure: ExtensionFailureState,
  ) {}

  get sessionId(): string {
    return this.runtimeHost.session.sessionId;
  }

  async run(task: string): Promise<PiWorkerExecutionResult> {
    if (this.extensionFailure.error) throw this.extensionFailure.error;
    try {
      await this.runtimeHost.session.prompt(task, { expandPromptTemplates: false });
    } catch (error) {
      throw this.extensionFailure.error ?? error;
    }
    return this.withControl(async () => {
      await this.runtimeHost.session.waitForIdle();
      this.finished = true;
      if (this.extensionFailure.error) throw this.extensionFailure.error;
      const failure = assistantFailure(this.runtimeHost);
      if (failure) throw failure;
      return { text: this.runtimeHost.session.getLastAssistantText() ?? "" };
    });
  }

  send(text: string): Promise<void> {
    return this.withControl(async () => {
      if (this.finished) throw new Error("Pi worker has already finished.");
      if (this.extensionFailure.error) throw this.extensionFailure.error;
      await this.runtimeHost.session.sendUserMessage(text, {
        deliverAs: "steer",
        expandPromptTemplates: false,
      });
    });
  }

  cancel(): Promise<void> {
    this.finished = true;
    return this.runtimeHost.session.abort();
  }

  private withControl<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.controls.catch(() => {}).then(operation);
    this.controls = result.then(() => {}, () => {});
    return result;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    let disposeFailure: unknown;
    try {
      await this.runtimeHost.dispose();
    } catch (error) {
      disposeFailure = error;
    } finally {
      this.modelRuntime.close();
    }
    if (this.extensionFailure.error) throw this.extensionFailure.error;
    if (disposeFailure) throw disposeFailure;
  }
}

function workerEventProjection(
  event: AgentSessionEvent,
  emit: (event: PiWorkerEvent) => void,
): void {
  if (event.type === "message_end" && event.message.role === "assistant") {
    const content = event.message.content;
    const text = Array.isArray(content)
      ? content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")
      : "";
    if (text) {
      emit({
        protocol: PI_WORKER_PROTOCOL_VERSION,
        type: "output",
        text: bounded(text, PI_WORKER_MAX_EVENT_TEXT),
      });
    }
    return;
  }
  if (event.type === "tool_execution_start") {
    emit({
      protocol: PI_WORKER_PROTOCOL_VERSION,
      type: "notice",
      text: `Using ${event.toolName}.`,
    });
    return;
  }
  if (event.type === "auto_retry_start") {
    emit({
      protocol: PI_WORKER_PROTOCOL_VERSION,
      type: "notice",
      text: `Pi is retrying the provider request (${event.attempt}/${event.maxAttempts}).`,
    });
  }
}

async function canonicalWorkerPaths(input: PiWorkerStartCommand): Promise<{
  home: string;
  root: string;
  cwd: string;
}> {
  if (!isAbsolute(input.ghostHome) || !isAbsolute(input.root) || !isAbsolute(input.cwd)) {
    throw new Error("Pi worker paths must be absolute.");
  }
  const [home, root, cwd] = await Promise.all([
    realpath(input.ghostHome),
    realpath(input.root),
    realpath(input.cwd),
  ]);
  const [rootInfo, cwdInfo] = await Promise.all([stat(root), stat(cwd)]);
  if (!isGhostHome(home)) throw new Error("Pi worker ghost home is invalid.");
  if (!rootInfo.isDirectory() || !cwdInfo.isDirectory() || !isWithin(root, cwd)) {
    throw new Error("Pi worker cwd must stay inside its project root.");
  }
  return { home, root, cwd };
}

export async function createNativePiWorkerSession(
  input: PiWorkerStartCommand,
  emit: (event: PiWorkerEvent) => void,
  options: NativePiWorkerSessionOptions = {},
): Promise<PiWorkerChildSession> {
  if (!isTaskId(input.taskId)) throw new Error("Pi worker task id is invalid.");
  const { home, root, cwd } = await canonicalWorkerPaths(input);
  const paths = ghostPaths(home);
  const transcriptDir = join(paths.taskDir, "pi");
  ensurePrivateDirectory(paths.taskDir);
  ensurePrivateDirectory(transcriptDir);

  const modelRuntime = await createGhostPiRuntime({
    authPath: join(paths.agentDir, "auth.json"),
    modelsPath: join(paths.home, "models.json"),
    allowModelNetwork: !input.offline,
  });
  let runtimeHost: AgentSessionRuntime | undefined;
  try {
    const models = readGhostModels(paths.home);
    const taskBinding = models?.roles?.task_model ?? resolveChatModelRef(models);
    const skillPaths = machineSkillPaths(options.ownerHome ?? homedir());
    const machineSkillRoots = (await Promise.all(
      skillPaths.map((path) => realpath(path).catch(() => null)),
    )).filter((path): path is string => path !== null);
    const admittedResourceRoots = [root, ...machineSkillRoots];
    const sessionManager = SessionManager.create(cwd, transcriptDir, { id: input.taskId });
    const createRuntime = async (options: {
      cwd: string;
      agentDir: string;
      sessionManager: SessionManager;
      sessionStartEvent?: { type: "session_start"; reason: "startup" | "reload" | "new" | "resume" | "fork"; previousSessionFile?: string };
    }) => {
      const settingsManager = SettingsManager.create(options.cwd, options.agentDir, {
        projectTrusted: true,
      });
      const services = await createAgentSessionServices({
        cwd: options.cwd,
        agentDir: options.agentDir,
        settingsManager,
        modelRuntime: modelRuntime.runtime,
        resourceLoaderOptions: {
          additionalSkillPaths: skillPaths,
          agentsFilesOverride: (base) => ({
            agentsFiles: base.agentsFiles.filter((file) =>
              canonicalPathWithin(resolve(file.path), [root])),
          }),
          appendSystemPromptOverride: (base) => [...base, PI_WORKER_SYSTEM_PROMPT],
          extensionsOverride: protectPiWorkerTools,
          skillsOverride: (base) => restrictPiWorkerSkills(base, admittedResourceRoots),
          noThemes: true,
        },
      });
      const model = resolveChatModel(taskBinding, modelRuntime.getAvailableSnapshot());
      const created = await createAgentSessionFromServices({
        services,
        sessionManager: options.sessionManager,
        ...(options.sessionStartEvent ? { sessionStartEvent: options.sessionStartEvent } : {}),
        ...(model ? { model } : {}),
        tools: [...PI_WORKER_TOOL_NAMES],
      });
      const diagnostics: PiWorkerDiagnostic[] = [
        ...services.diagnostics,
        ...settingsDiagnostics(services.settingsManager),
        ...created.extensionsResult.errors.map(({ path, error }) => ({
          type: "error" as const,
          message: `Failed to load extension "${path}": ${error}`,
        })),
      ];
      return { ...created, services, diagnostics };
    };
    runtimeHost = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir: paths.agentDir,
      sessionManager,
      sessionStartEvent: { type: "session_start", reason: "startup" },
    });
    const activeRuntime = runtimeHost;
    const startupErrors = activeRuntime.diagnostics.filter((diagnostic) => diagnostic.type === "error");
    if (startupErrors.length > 0) {
      throw new Error(startupErrors.map((diagnostic) => diagnostic.message).join("\n"));
    }
    if (!activeRuntime.session.model) throw new Error("Pi worker has no available model.");
    const extensionFailure: ExtensionFailureState = {};
    await activeRuntime.session.bindExtensions({
      mode: "print",
      abortHandler: () => void activeRuntime.session.abort(),
      shutdownHandler: () => void activeRuntime.session.abort(),
      onError: (error) => {
        const message = `Extension error (${error.extensionPath}): ${error.error}`;
        extensionFailure.error ??= new Error(message);
        emit({
          protocol: PI_WORKER_PROTOCOL_VERSION,
          type: "notice",
          text: bounded(message, PI_WORKER_MAX_EVENT_TEXT),
        });
        void activeRuntime.session.abort();
      },
    });
    if (extensionFailure.error) throw extensionFailure.error;
    for (const diagnostic of activeRuntime.diagnostics) {
      emit({
        protocol: PI_WORKER_PROTOCOL_VERSION,
        type: "notice",
        text: bounded(diagnostic.message, PI_WORKER_MAX_EVENT_TEXT),
      });
    }
    const unsubscribe = activeRuntime.session.subscribe((event) => workerEventProjection(event, emit));
    return new NativePiWorkerSession(activeRuntime, modelRuntime, unsubscribe, extensionFailure);
  } catch (error) {
    await runtimeHost?.dispose().catch(() => {});
    modelRuntime.close();
    throw error;
  }
}

async function nextCommand(
  iterator: AsyncIterator<string>,
): Promise<ReturnType<typeof parsePiWorkerCommand>> {
  const next = await iterator.next();
  if (next.done) return null;
  return parsePiWorkerCommand(parsePiWorkerLine(next.value));
}

/** Run one child lifecycle over an injected line stream; used by the hidden command and tests. */
export async function runPiWorkerChild(
  lines: AsyncIterable<string>,
  dependencies: PiWorkerChildDependencies,
): Promise<number> {
  const iterator = lines[Symbol.asyncIterator]();
  let worker: PiWorkerChildSession | undefined;
  try {
    const start = await nextCommand(iterator);
    if (start?.type !== "start") throw new Error("The first Pi worker command must be start.");
    const createSession = dependencies.createSession ?? createNativePiWorkerSession;
    worker = await createSession(start, dependencies.emit);
    const sessionId = worker.sessionId;
    dependencies.emit({
      protocol: PI_WORKER_PROTOCOL_VERSION,
      type: "started",
      sessionId,
    });

    const cancelled = Promise.withResolvers<string>();
    const commandFailed = Promise.withResolvers<never>();
    let accepting = true;
    let cancellationRequested = false;
    const commands = (async () => {
      while (accepting) {
        const command = await nextCommand(iterator);
        if (!command) {
          if (accepting) throw new Error("The Pi worker controller disconnected.");
          return;
        }
        if (command.type === "start") throw new Error("Pi worker start may only be sent once.");
        if (command.type === "message") {
          void worker?.send(command.text).then(
            () => {
              if (!accepting) return;
              dependencies.emit({
                protocol: PI_WORKER_PROTOCOL_VERSION,
                type: "ack",
                requestId: command.requestId,
              });
            },
            (error: unknown) => {
              if (!accepting) return;
              dependencies.emit({
                protocol: PI_WORKER_PROTOCOL_VERSION,
                type: "error",
                requestId: command.requestId,
                message: bounded(
                  error instanceof Error ? error.message : String(error),
                  PI_WORKER_MAX_ERROR_TEXT,
                ),
              });
            },
          );
          continue;
        }
        cancellationRequested = true;
        await worker?.cancel();
        cancelled.resolve(command.requestId);
        return;
      }
    })().catch(commandFailed.reject);

    const execution = worker.run(start.task).then(
      (result) => ({ type: "result" as const, result }),
      async (error: unknown) => {
        if (cancellationRequested) {
          return {
            type: "cancelled" as const,
            requestId: await cancelled.promise,
          };
        }
        throw error;
      },
    );
    const outcome = await Promise.race([
      execution,
      cancelled.promise.then((requestId) => ({ type: "cancelled" as const, requestId })),
      commandFailed.promise,
    ]);
    accepting = false;
    await iterator.return?.();
    await commands.catch(() => {});
    await worker.dispose();
    worker = undefined;

    if (outcome.type === "cancelled") {
      dependencies.emit({
        protocol: PI_WORKER_PROTOCOL_VERSION,
        type: "cancelled",
        requestId: outcome.requestId,
      });
    } else {
      dependencies.emit({
        protocol: PI_WORKER_PROTOCOL_VERSION,
        type: "result",
        sessionId,
        text: bounded(outcome.result.text, PI_WORKER_MAX_RESULT_TEXT),
      });
    }
    return 0;
  } catch (error) {
    await worker?.cancel().catch(() => {});
    await worker?.dispose().catch(() => {});
    dependencies.emit({
      protocol: PI_WORKER_PROTOCOL_VERSION,
      type: "error",
      message: bounded(
        error instanceof Error ? error.message : String(error),
        PI_WORKER_MAX_ERROR_TEXT,
      ),
    });
    return 1;
  }
}

export async function piWorkerCommand(argv: string[]): Promise<number> {
  if (argv.length > 0) {
    process.stderr.write("worker-pi accepts JSON lines on stdin and no arguments.\n");
    return 2;
  }
  scrubProviderEnv(process.env, { offline: process.env.PI_OFFLINE === "1" });
  const input = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  const emit = (event: PiWorkerEvent) => process.stdout.write(encodePiWorkerLine(event));
  try {
    return await runPiWorkerChild(input, { emit });
  } finally {
    input.close();
  }
}
