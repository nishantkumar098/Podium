import { Module } from "@nestjs/common";
import { CrewAvailabilityService } from "./crew-availability.service";
import { WhatsAppConfigService } from "./whatsapp-config.service";
import { WhatsAppController } from "./whatsapp.controller";
import { LiveWhatsAppProvider, SandboxWhatsAppProvider, WhatsAppProvider } from "./whatsapp.provider";

/**
 * WhatsApp, through AiSensy (white-labelled here as "Let's Build Brands").
 *
 * The provider is chosen once, at boot, from the configured mode — rather
 * than branched on at every send. A service asking "are we live?" before
 * each message is a service that will one day forget to ask.
 */
@Module({
  controllers: [WhatsAppController],
  providers: [
    WhatsAppConfigService,
    SandboxWhatsAppProvider,
    LiveWhatsAppProvider,
    {
      provide: WhatsAppProvider,
      inject: [WhatsAppConfigService, SandboxWhatsAppProvider, LiveWhatsAppProvider],
      useFactory: (config: WhatsAppConfigService, sandbox: SandboxWhatsAppProvider, live: LiveWhatsAppProvider) =>
        config.mode === "live" ? live : sandbox,
    },
    CrewAvailabilityService,
  ],
  exports: [CrewAvailabilityService, WhatsAppConfigService, WhatsAppProvider],
})
export class WhatsAppModule {}
