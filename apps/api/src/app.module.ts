import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { resolve } from "node:path";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "./auth/auth.module";
import { ChatModule } from "./chat/chat.module";
import { CitiesModule } from "./cities/cities.module";
import { ClientsModule } from "./clients/clients.module";
import { CommonModule } from "./common/common.module";
import { CrmModule } from "./crm/crm.module";
import { HttpExceptionFilter } from "./common/filters/http-exception.filter";
import { JwtAuthGuard } from "./common/guards/jwt-auth.guard";
import { MustChangePasswordGuard } from "./common/guards/must-change-password.guard";
import { PermissionsGuard } from "./common/guards/permissions.guard";
import { ReadOnlyGuard } from "./common/guards/read-only.guard";
import { AuditInterceptor } from "./common/interceptors/audit.interceptor";
import { ReadCacheInterceptor } from "./common/interceptors/read-cache.interceptor";
import { MailModule } from "./common/mail/mail.module";
import { PrismaModule } from "./common/prisma/prisma.module";
import { SchedulerModule } from "./common/scheduler/scheduler.module";
import { FinanceModule } from "./finance/finance.module";
import { FlowsModule } from "./flows/flows.module";
import { GovernanceModule } from "./governance/governance.module";
import { HealthModule } from "./health/health.module";
import { InventoryModule } from "./inventory/inventory.module";
import { InvoicesModule } from "./invoices/invoices.module";
import { GoogleModule } from "./google/google.module";
import { AutomationModule } from "./automation/automation.module";
import { DocumentsModule } from "./documents/documents.module";
import { LettersModule } from "./letters/letters.module";
import { PeopleModule } from "./people/people.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { MeModule } from "./me/me.module";
import { SystemModule } from "./system/system.module";
import { MeetingsModule } from "./meetings/meetings.module";
import { EventDayModule } from "./eventday/eventday.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { ProductsModule } from "./products/products.module";
import { PlaybooksModule } from "./playbooks/playbooks.module";
import { ProcurementModule } from "./procurement/procurement.module";
import { RecipesModule } from "./recipes/recipes.module";
import { ReportsModule } from "./reports/reports.module";
import { ProjectsModule } from "./projects/projects.module";
import { TasksModule } from "./tasks/tasks.module";
import { UsersModule } from "./users/users.module";
import { VendorsModule } from "./vendors/vendors.module";
import { WhatsAppModule } from "./whatsapp/whatsapp.module";

@Module({
  imports: [
    ProductsModule,
    /**
     * The env file is resolved from this file's own location, never from
     * `process.cwd()`. `pnpm --filter @podium/api dev` (and `pnpm dev:api`,
     * which delegates to it) runs with cwd = apps/api, so the default
     * cwd-relative lookup silently missed the monorepo-root `.env` the
     * README tells you to create — the API then died on boot with
     * `Configuration key "JWT_ACCESS_SECRET" does not exist`, which reads
     * like a missing secret rather than a file the loader never opened.
     *
     * Both entries below resolve to the repo root: `__dirname` is
     * apps/api/src under ts-node/`nest start`, and apps/api/dist once
     * compiled — three levels up either way. A cwd-relative `.env` is kept
     * last so running from the repo root still works, and real process env
     * vars (CI, Docker) always win over anything in a file.
     */
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [resolve(__dirname, "../../../.env"), ".env"],
    }),
    ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 120 }] }),
    PrismaModule,
    CommonModule,
    // No-op unless PODIUM_INLINE_SCHEDULER=1 — see scheduler.module.ts.
    SchedulerModule.forRoot(),
    HealthModule,
    MailModule,
    AuthModule,
    ChatModule,
    UsersModule,
    CitiesModule,
    ClientsModule,
    CrmModule,
    AutomationModule,
    DocumentsModule,
    LettersModule,
    PeopleModule,
    DashboardModule,
    MeModule,
    SystemModule,
    MeetingsModule,
    EventDayModule,
    GoogleModule,
    ProcurementModule,
    ProjectsModule,
    ReportsModule,
    TasksModule,
    FinanceModule,
    FlowsModule,
    GovernanceModule,
    InventoryModule,
    InvoicesModule,
    NotificationsModule,
    PlaybooksModule,
    RecipesModule,
    VendorsModule,
    WhatsAppModule,
  ],
  providers: [
    // Order matters: JWT auth resolves req.user first, then the forced
    // password-change gate (BUG-003) runs before RBAC — a user mid-forced-
    // change has no business reaching a permission check at all.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: MustChangePasswordGuard },
    // Before RBAC: a read-only role's refusal should read "your access is
    // read-only" rather than name a permission they were never meant to
    // hold, and this is also what covers the routes that deliberately carry
    // no @RequirePermissions at all (chat, notifications, SOPs, settings).
    { provide: APP_GUARD, useClass: ReadOnlyGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ReadCacheInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
