import { Module } from "@nestjs/common";
import { WhatsAppModule } from "../whatsapp/whatsapp.module";
import { InvoiceLinkService } from "./invoice-link.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { InvoicesController } from "./invoices.controller";
import { InvoicesService } from "./invoices.service";

@Module({
  imports: [WhatsAppModule],
  controllers: [InvoicesController],
  providers: [InvoicesService, InvoicePdfService, InvoiceLinkService],
  // Exported so the BullMQ worker's overdue sweep drives the same service
  // method the e2e test does, rather than a second copy of the logic.
  exports: [InvoicesService],
})
export class InvoicesModule {}
