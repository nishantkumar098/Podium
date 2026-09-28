import { Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { RequestUser } from "../common/types";
import { GoogleService } from "./google.service";

const sendSchema = z.object({
  to: z.string().trim().email(),
  subject: z.string().trim().min(1).max(300),
  body: z.string().min(1).max(50_000),
});

/**
 * Phase 9's API surface. Every route here is honest about the integration's
 * state: with no credentials configured they all return 503 with the exact
 * setup steps, rather than empty arrays that read as "no mail today".
 */
@Controller("integrations/google")
export class GoogleController {
  constructor(private readonly google: GoogleService) {}

  @Get("status")
  status(@CurrentUser() user: RequestUser) {
    return this.google.status(user);
  }

  @Get("auth-url")
  authUrl(@CurrentUser() user: RequestUser, @Query("state") state = "podium") {
    return this.google.authUrl(user, state);
  }

  @Post("callback")
  callback(@CurrentUser() user: RequestUser, @Body("code") code: string) {
    return this.google.handleCallback(user, code);
  }

  @Delete("connection")
  disconnect(@CurrentUser() user: RequestUser) {
    return this.google.disconnect(user);
  }

  @Post("sync")
  sync(@CurrentUser() user: RequestUser) {
    return this.google.sync(user);
  }

  // The person's OWN connected mailbox. Gating these on clients:view meant
  // Operations and Finance could not read their own mail while Sales could.
  @Get("emails")
  emails(@CurrentUser() user: RequestUser, @Query("limit") limit?: string) {
    return this.google.listEmails(user, limit ? Number(limit) : undefined);
  }

  @Post("emails/:id/read")
  markRead(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.google.markRead(user, id);
  }

  /** Sends from the caller's own connected Google account. */
  @Post("send")
  send(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(sendSchema)) body: z.infer<typeof sendSchema>) {
    return this.google.sendEmail(user, body.to, body.subject, body.body);
  }
}
