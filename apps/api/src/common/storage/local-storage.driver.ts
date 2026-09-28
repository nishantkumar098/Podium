import { Injectable } from "@nestjs/common";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { StorageDriver } from "./storage.interface";

/**
 * Disk-backed storage for local dev (blueprint §26). Keys are relative
 * paths under STORAGE_LOCAL_PATH — resolved and checked against directory
 * traversal before every read/write/delete, since a key ultimately
 * originates from a document's own name (user-controlled input).
 */
@Injectable()
export class LocalStorageDriver implements StorageDriver {
  private readonly root: string;

  constructor() {
    this.root = path.resolve(process.env.STORAGE_LOCAL_PATH ?? "./.local-storage");
  }

  private resolveKey(key: string): string {
    const full = path.resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new Error(`Storage key escapes the storage root: ${key}`);
    }
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const full = this.resolveKey(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.resolveKey(key));
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolveKey(key), { force: true });
  }
}
