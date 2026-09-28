/**
 * File storage abstraction (Phase F, blueprint §26/§40). One interface,
 * swappable drivers — `.env`'s STORAGE_DRIVER picks which one, exactly the
 * shape the .env.example comment already promised before this module
 * existed ("local uses disk storage behind the same interface as S3").
 *
 * Only the local driver is implemented in this phase — there are no real S3
 * credentials anywhere in this build, and a second, untestable driver behind
 * the same interface would be dead code, not a real capability. StorageModule
 * fails fast at startup if STORAGE_DRIVER names anything else, rather than
 * silently falling back to local or no-opping.
 */
export interface StorageDriver {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export const STORAGE_DRIVER = Symbol("STORAGE_DRIVER");
