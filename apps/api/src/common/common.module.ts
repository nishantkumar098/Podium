import { Global, Module } from "@nestjs/common";
import { CityScopeService } from "./city-scope/city-scope.service";
import { AccessScopeService } from "./rbac/access-scope.service";

@Global()
@Module({
  providers: [CityScopeService, AccessScopeService],
  exports: [CityScopeService, AccessScopeService],
})
export class CommonModule {}
