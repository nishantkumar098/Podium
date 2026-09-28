import { Module } from "@nestjs/common";
import { InventoryModule } from "../inventory/inventory.module";
import { ProcurementController } from "./procurement.controller";
import { ProcurementService } from "./procurement.service";

@Module({
  imports: [InventoryModule],
  controllers: [ProcurementController],
  providers: [ProcurementService],
})
export class ProcurementModule {}
