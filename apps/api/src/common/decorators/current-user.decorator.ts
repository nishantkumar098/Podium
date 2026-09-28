import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { RequestUser } from "../types";

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestUser => {
  const req = ctx.switchToHttp().getRequest();
  return req.user as RequestUser;
});
