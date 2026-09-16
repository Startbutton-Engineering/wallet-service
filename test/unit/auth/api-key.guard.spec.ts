import { ApiKeyGuard } from '../../../src/auth/api-key.guard';
import { IS_PUBLIC_KEY } from '../../../src/auth/public.decorator';
import { AppConfig } from '../../../src/config';
import { AppError, ErrorCode } from '../../../src/common/errors';
import { loadConfig } from '../../../src/config';
import { mockExecutionContext, mockReflector, mockRequest } from '../../mocks';

const config = (apiKeys: string[]): AppConfig => ({
  ...loadConfig({} as NodeJS.ProcessEnv),
  apiKeys,
});

describe('ApiKeyGuard', () => {
  const guard = (apiKeys: string[], isPublic?: boolean) =>
    new ApiKeyGuard(config(apiKeys), mockReflector(isPublic));

  it('allows a request carrying a configured key', () => {
    const context = mockExecutionContext({ request: mockRequest({ 'x-api-key': 'k1' }) });
    expect(guard(['k1', 'k2']).canActivate(context.asContext)).toBe(true);
  });

  it('lets a @Public route through without any key', () => {
    const context = mockExecutionContext({ request: mockRequest({}) });
    expect(guard([], true).canActivate(context.asContext)).toBe(true);
  });

  it('looks the public flag up on both the handler and the controller', () => {
    const reflector = mockReflector(true);
    const context = mockExecutionContext();
    new ApiKeyGuard(config([]), reflector).canActivate(context.asContext);

    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, [
      context.asContext.getHandler(),
      context.asContext.getClass(),
    ]);
  });

  it.each([
    ['no key at all', {}],
    ['an empty key', { 'x-api-key': '' }],
    ['an unknown key', { 'x-api-key': 'nope' }],
  ])('rejects a protected route with %s', (_label, headers) => {
    const context = mockExecutionContext({ request: mockRequest(headers as Record<string, string>) });
    let thrown: AppError | undefined;
    try {
      guard(['k1']).canActivate(context.asContext);
    } catch (err) {
      thrown = err as AppError;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown?.code).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it('rejects everything when no keys are configured', () => {
    const context = mockExecutionContext({ request: mockRequest({ 'x-api-key': 'k1' }) });
    expect(() => guard([]).canActivate(context.asContext)).toThrow(AppError);
  });
});
