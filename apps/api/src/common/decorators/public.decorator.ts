import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "podium:isPublic";

/** Opts an endpoint out of the global JwtAuthGuard — login/refresh/health only. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
