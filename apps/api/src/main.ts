import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import cookieParser from "cookie-parser";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: { origin: process.env.WEB_BASE_URL ?? "http://localhost:3000", credentials: true } });
  app.setGlobalPrefix("api");
  app.use(cookieParser());
  // Behind a reverse proxy (Caddy in production) every request arrives from
  // the proxy's address; trust its X-Forwarded-For so rate limiting and
  // audit logs see each visitor's real IP, not one shared one.
  if (process.env.TRUST_PROXY) app.getHttpAdapter().getInstance().set("trust proxy", Number(process.env.TRUST_PROXY) || 1);
  const port = process.env.API_PORT ? Number(process.env.API_PORT) : 3001;
  await app.listen(port);
  Logger.log(`Podium API listening on http://localhost:${port}/api`, "Bootstrap");
}

bootstrap();
