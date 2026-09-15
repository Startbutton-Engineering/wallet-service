import { ArgumentMetadata, HttpStatus } from '@nestjs/common';
import z from 'zod';
import { ZodValidationPipe } from '../../../src/common/zod-validation.pipe';
import { AppError, ErrorCode } from '../../../src/common/errors';
import { collectionSchema } from '../../../src/collections/dto';

const metadata: ArgumentMetadata = { type: 'body' };

const schema = z.object({
  ownerId: z.string().min(1),
  nested: z.object({ amount: z.number() }).optional(),
});

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(schema);

  it('returns the parsed value on success', () => {
    expect(pipe.transform({ ownerId: 'm1' }, metadata)).toEqual({ ownerId: 'm1' });
  });

  it('returns the schema output, not the raw input', () => {
    const coercing = new ZodValidationPipe(z.object({ amount: z.coerce.number() }));
    expect(coercing.transform({ amount: '5' }, metadata)).toEqual({ amount: 5 });
  });

  it('throws a VALIDATION_FAILED AppError listing the failing paths', () => {
    let thrown: AppError | undefined;
    try {
      pipe.transform({ ownerId: '' }, metadata);
    } catch (err) {
      thrown = err as AppError;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown?.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(thrown?.message).toBe('Request validation failed');
    expect(thrown?.details).toEqual({
      issues: [expect.objectContaining({ path: 'ownerId' })],
    });
  });

  it('joins nested paths with dots', () => {
    const run = () => pipe.transform({ ownerId: 'm1', nested: { amount: 'x' } }, metadata);
    expect(run).toThrow(AppError);
    try {
      run();
    } catch (err) {
      expect((err as AppError).details).toEqual({
        issues: [expect.objectContaining({ path: 'nested.amount' })],
      });
    }
  });

  it('rejects a completely wrong shape', () => {
    expect(() => pipe.transform(null, metadata)).toThrow(AppError);
  });

  /** A malformed amount used to reach here as a raw SyntaxError from BigInt(), which the
   * pipe does not catch — so the request 500ed instead of 400ing. */
  it.each(['abc', '1.5', '1e3'])('turns the malformed amount %p into a 400, not a 500', (amount) => {
    const body = { collectionId: 'col-1', ownerId: 'm1', currency: 'NGN', amount };
    const collections = new ZodValidationPipe(collectionSchema);

    let thrown: unknown;
    try {
      collections.transform(body, metadata);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).not.toBeInstanceOf(SyntaxError);
    expect((thrown as AppError).code).toBe(ErrorCode.VALIDATION_FAILED);
    expect((thrown as AppError).httpStatus).toBe(HttpStatus.BAD_REQUEST);
    expect((thrown as AppError).details).toEqual({
      issues: [expect.objectContaining({ path: 'amount' })],
    });
  });
});
