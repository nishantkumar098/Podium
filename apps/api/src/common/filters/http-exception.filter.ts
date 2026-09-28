import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { Response } from "express";
import { redactError } from "../redact";

/**
 * Standard error envelope per blueprint §40: { error: { code, message, details } }.
 * Every thrown HttpException (including guard/pipe rejections) is normalized here
 * so clients never have to branch on response shape.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("HttpExceptionFilter");

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = "INTERNAL_ERROR";
    let message = "Something went wrong.";
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === "string") {
        message = body;
      } else if (typeof body === "object" && body !== null) {
        const b = body as Record<string, unknown>;
        message = typeof b.message === "string" ? b.message : Array.isArray(b.message) ? b.message.join("; ") : message;
        details = b.message && Array.isArray(b.message) ? b.message : undefined;
      }
      code = HttpStatus[status] ?? "HTTP_ERROR";
    } else if (exception instanceof Error) {
      /**
       * Unexpected errors get redacted before they touch a log. Prisma renders
       * the offending row into its messages, so an insert that violates a
       * constraint would otherwise write a real customer's phone number and
       * e-mail into plaintext logs. The entity id survives redaction, which is
       * what is actually needed to investigate.
       */
      const safe = redactError(exception);
      this.logger.error(safe.message, safe.stack);
      // The client gets a generic message: an internal error's text is a
      // detail of our implementation, not something a caller should parse.
      message = "Something went wrong.";
    }

    res.status(status).json({ error: { code, message, details } });
  }
}
