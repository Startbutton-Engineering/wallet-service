import { ArgumentMetadata, Injectable, PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";
import { AppError } from "./errors";

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}

  transform(value: any, metadata: ArgumentMetadata) {
    const result = this.schema.safeParse(value);
    if(!result.success) {
      throw AppError.validation('Request validation failed', {
        issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message}))
      });
    }
    return result.data;
  }
}