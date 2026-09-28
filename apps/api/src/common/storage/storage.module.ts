import { Module } from "@nestjs/common";
import { LocalStorageDriver } from "./local-storage.driver";
import { STORAGE_DRIVER } from "./storage.interface";

@Module({
  providers: [
    {
      provide: STORAGE_DRIVER,
      useFactory: () => {
        const driver = process.env.STORAGE_DRIVER ?? "local";
        if (driver !== "local") {
          // Fail fast rather than silently falling back to local storage or
          // no-opping — a workspace configured for S3 that got local disk
          // instead would lose every uploaded file on the next deploy.
          throw new Error(
            `STORAGE_DRIVER="${driver}" is not implemented — only "local" exists in this build (see storage.interface.ts).`,
          );
        }
        return new LocalStorageDriver();
      },
    },
  ],
  exports: [STORAGE_DRIVER],
})
export class StorageModule {}
