import { Module } from "@nestjs/common";
import { GmailProvider, LiveGmailProvider, SandboxGmailProvider } from "./gmail.provider";
import { GoogleConfigService } from "./google-config.service";
import { GoogleController } from "./google.controller";
import { GoogleService } from "./google.service";

@Module({
  controllers: [GoogleController],
  providers: [
    GoogleConfigService,
    SandboxGmailProvider,
    LiveGmailProvider,
    {
      // The provider is chosen once, from configuration, so no request can
      // pick which implementation it gets.
      provide: GmailProvider,
      inject: [GoogleConfigService, SandboxGmailProvider, LiveGmailProvider],
      useFactory: (config: GoogleConfigService, sandbox: SandboxGmailProvider, live: LiveGmailProvider) =>
        config.mode === "live" ? live : sandbox,
    },
    GoogleService,
  ],
  exports: [GoogleConfigService, GoogleService],
})
export class GoogleModule {}
