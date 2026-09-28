import { Global, Module } from "@nestjs/common";
import { MailConfigService } from "./mail-config.service";
import { MailService } from "./mail.service";

/**
 * Global so both the invoices module and the auth module (password invites)
 * use the same sender instance — and therefore the same sandbox outbox.
 */
@Global()
@Module({
  providers: [MailConfigService, MailService],
  exports: [MailConfigService, MailService],
})
export class MailModule {}
