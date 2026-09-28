import { BadRequestException, Body, Controller, Post, Req, Res } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { loginSchema, refreshSchema } from "@podium/shared-types";
import type { Request, Response } from "express";
import { Public } from "../common/decorators/public.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AuthService } from "./auth.service";

/**
 * Sign-in only. There is deliberately no sign-up, invite-acceptance or
 * self-service password-change route: accounts are created by an
 * administrator and passwords are reset only by a Founder or Admin
 * (POST /users/:id/reset-password).
 */
@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } }) // rate-limited per blueprint §30
  @Post("login")
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: ReturnType<typeof loginSchema.parse>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(body);
    this.setAuthCookies(res, result.accessToken, result.refreshToken);
    return result;
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post("refresh")
  async refresh(
    @Body(new ZodValidationPipe(refreshSchema)) body: ReturnType<typeof refreshSchema.parse>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = this.resolveRefreshToken(body, req);
    const result = await this.authService.refresh(refreshToken);
    this.setAuthCookies(res, result.accessToken, result.refreshToken);
    return result;
  }

  @Public()
  @Post("logout")
  async logout(
    @Body(new ZodValidationPipe(refreshSchema)) body: ReturnType<typeof refreshSchema.parse>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = this.resolveRefreshToken(body, req);
    await this.authService.logout(refreshToken);
    this.clearAuthCookies(res);
    return { ok: true };
  }

  /**
   * Phase H: a browser caller has no way to read the httpOnly refresh-token
   * cookie back into a request body, so the body field is optional and this
   * falls back to the cookie. A non-browser caller with no cookie jar keeps
   * working exactly as before by passing it in the body.
   */
  private resolveRefreshToken(body: ReturnType<typeof refreshSchema.parse>, req: Request): string {
    const token = body.refreshToken ?? req.cookies?.refreshToken;
    if (!token) throw new BadRequestException("refreshToken is required (body or cookie).");
    return token;
  }

  /**
   * Phase H: mirrors the JSON body's tokens into httpOnly cookies so the
   * browser frontend never has to keep them in localStorage. Both tokens
   * still come back in the body too — every existing e2e test and any
   * non-browser caller reads them from there, unaffected by this addition.
   */
  private setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
    const secure = process.env.NODE_ENV === "production";
    res.cookie("accessToken", accessToken, {
      httpOnly: true,
      sameSite: "lax",
      secure,
      path: "/",
      maxAge: this.authService.getAccessTokenTtlMs(),
    });
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      sameSite: "lax",
      secure,
      path: "/",
      maxAge: this.authService.getRefreshTokenTtlMs(),
    });
  }

  private clearAuthCookies(res: Response): void {
    res.clearCookie("accessToken", { path: "/" });
    res.clearCookie("refreshToken", { path: "/" });
  }
}
