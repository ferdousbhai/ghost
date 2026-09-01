import { spawn, type ChildProcess } from "node:child_process";
import { terminateOwnedProcessGroup } from "../../src/owned-process.js";
import type {
  NativeTaskOwnershipReceipt,
  NativeTaskScope,
  NativeTaskScopeLaunch,
  NativeTaskScopeManager,
} from "../../src/native-task-scope.js";

export function directTaskScope(unit = "ghost-task-test.scope"): NativeTaskScope {
  let child: ChildProcess | undefined;
  let stopping: Promise<void> | undefined;
  return {
    unit,
    spawn(input: NativeTaskScopeLaunch): ChildProcess {
      if (child) throw new Error("test scope already spawned");
      child = spawn(input.executable, [...input.args], {
        cwd: input.cwd,
        detached: true,
        env: input.environment,
        signal: input.signal,
        stdio: ["pipe", "pipe", input.stderr ?? "pipe"],
        windowsHide: true,
      });
      return child;
    },
    stopAndConfirm(): Promise<void> {
      stopping ??= (async () => {
        if (child?.pid !== undefined) await terminateOwnedProcessGroup(child.pid);
        child?.stdin?.destroy();
        child?.stdout?.destroy();
        child?.stderr?.destroy();
      })();
      return stopping;
    },
  };
}

export class FakeNativeTaskScopeManager implements NativeTaskScopeManager {
  readonly reservations: string[] = [];
  readonly stops: string[] = [];
  readonly collisions = new Set<string>();
  readonly unconfirmed = new Set<string>();
  readonly scopes = new Map<string, NativeTaskScope>();
  readonly receipts = new Map<string, NativeTaskOwnershipReceipt>();

  async reserve(
    taskId: string,
    receipt: NativeTaskOwnershipReceipt,
    signal: AbortSignal,
  ): Promise<NativeTaskScope> {
    if (signal.aborted) throw new Error("test scope admission aborted");
    this.reservations.push(taskId);
    if (this.collisions.has(taskId)) throw new Error("test scope collision");
    const scope = directTaskScope(`ghost-${taskId}.scope`);
    this.scopes.set(taskId, scope);
    this.receipts.set(taskId, { ...receipt });
    return scope;
  }

  async stopAndConfirm(
    taskId: string,
    receipt: NativeTaskOwnershipReceipt,
  ): Promise<void> {
    this.stops.push(taskId);
    if (this.unconfirmed.has(taskId)) throw new Error("test ownership unconfirmed");
    const expected = this.receipts.get(taskId);
    if (expected && (expected.version !== receipt.version
      || expected.kind !== receipt.kind || expected.nonce !== receipt.nonce)) {
      throw new Error("test ownership collision");
    }
    await this.scopes.get(taskId)?.stopAndConfirm();
  }

  recoverAndConfirm(
    taskId: string,
    receipt: NativeTaskOwnershipReceipt,
  ): Promise<void> {
    this.receipts.set(taskId, { ...receipt });
    return this.stopAndConfirm(taskId, receipt);
  }
}
