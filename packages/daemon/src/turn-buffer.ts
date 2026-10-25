import { closeSync, mkdirSync, mkdtempSync, openSync, readSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { xdgBaseDir } from "./xdg-user-dirs.js";

function temporaryFile(): number {
  const root = join(xdgBaseDir(process.env, "XDG_CACHE_HOME", homedir()), "ghost");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(root, "ghost-turn-"));
  const path = join(dir, "replay");
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx+", 0o600);
    unlinkSync(path);
    return fd;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    throw error;
  } finally {
    rmdirSync(dir);
  }
}

function read(fd: number, buffer: Buffer, position: number): void {
  let offset = 0;
  while (offset < buffer.length) {
    const size = readSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (size === 0) throw new Error("Incomplete replay file.");
    offset += size;
  }
}

function write(fd: number, buffer: Buffer, position: number): void {
  let offset = 0;
  while (offset < buffer.length) {
    const size = writeSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (size === 0) throw new Error("Could not write replay file.");
    offset += size;
  }
}

/** Small turns stay in memory; large replay histories use anonymous, seekable files. */
export class TurnBuffer {
  private frames: string[] = [];
  private data: number | undefined;
  private index: number | undefined;
  private bytes = 0;
  private count = 0;
  private closed = false;
  private readonly offset = Buffer.alloc(8);

  constructor(private readonly memoryLimit = 1_048_576) {}

  get length(): number { return this.count; }

  private append(frame: string): void {
    if (this.data === undefined || this.index === undefined) throw new Error("Replay files are not open.");
    const buffer = Buffer.from(frame);
    this.offset.writeBigUInt64LE(BigInt(this.bytes));
    write(this.data, buffer, this.bytes);
    write(this.index, this.offset, this.count * 8);
    this.bytes += buffer.length;
    this.count++;
  }

  push(frame: string): void {
    if (this.closed) throw new Error("Replay buffer is closed.");
    const size = Buffer.byteLength(frame);
    if (this.data === undefined && this.bytes + size <= this.memoryLimit) {
      this.frames.push(frame);
      this.bytes += size;
      this.count++;
      return;
    }
    if (this.data === undefined) {
      try {
        this.data = temporaryFile();
        this.index = temporaryFile();
        this.bytes = 0;
        this.count = 0;
        for (const saved of this.frames) this.append(saved);
        this.frames = [];
      } catch (error) {
        this.dispose();
        throw error;
      }
    }
    this.append(frame);
  }

  at(position: number): string {
    if (this.closed || !Number.isInteger(position) || position < 0 || position >= this.count) throw new RangeError("Invalid replay position.");
    if (this.data === undefined || this.index === undefined) return this.frames[position] as string;
    const offsets = Buffer.alloc(position + 1 < this.count ? 16 : 8);
    read(this.index, offsets, position * 8);
    const start = Number(offsets.readBigUInt64LE(0));
    const end = offsets.length === 16 ? Number(offsets.readBigUInt64LE(8)) : this.bytes;
    const frame = Buffer.alloc(end - start);
    read(this.data, frame, start);
    return frame.toString("utf8");
  }

  dispose(): void {
    this.closed = true;
    this.frames = [];
    if (this.data !== undefined) closeSync(this.data);
    if (this.index !== undefined) closeSync(this.index);
    this.data = undefined;
    this.index = undefined;
  }
}
