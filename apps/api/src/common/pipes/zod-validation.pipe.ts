import { BadRequestException, PipeTransform } from "@nestjs/common";
import type { ZodTypeAny } from "zod";

/**
 * Validates request bodies against the Zod schemas shared with the
 * frontend (@podium/shared-types) — one schema, not a duplicated
 * class-validator DTO, per the stack decision in blueprint §8.
 */
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodTypeAny) {}

  transform(value: unknown) {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
    }
    return result.data;
  }
}
