import { IdempotencyKey } from '../../../src/common/idempotency-key.decorator';
import { TenantId } from '../../../src/common/tenant.decorator';
import { Public, IS_PUBLIC_KEY } from '../../../src/auth/public.decorator';
import { AppError, ErrorCode } from '../../../src/common/errors';
import { mockExecutionContext, mockRequest, paramDecoratorFactory } from '../../mocks';

const idempotencyKey = paramDecoratorFactory(IdempotencyKey);
const tenantId = paramDecoratorFactory(TenantId);

const contextWith = (headers: Record<string, string>) =>
  mockExecutionContext({ request: mockRequest(headers) }).asContext;

describe('@IdempotencyKey', () => {
  it('returns the header value', () => {
    expect(idempotencyKey(undefined, contextWith({ 'idempotency-key': 'key-1' }))).toBe('key-1');
  });

  it('trims surrounding whitespace', () => {
    expect(idempotencyKey(undefined, contextWith({ 'idempotency-key': '  key-1  ' }))).toBe('key-1');
  });

  it.each([
    ['missing', {}],
    ['empty', { 'idempotency-key': '' }],
    ['whitespace only', { 'idempotency-key': '   ' }],
  ])('rejects a %s key', (_label, headers) => {
    let thrown: AppError | undefined;
    try {
      idempotencyKey(undefined, contextWith(headers as Record<string, string>));
    } catch (err) {
      thrown = err as AppError;
    }
    expect(thrown?.code).toBe(ErrorCode.MISSING_IDEMPOTENCY_KEY);
  });
});

describe('@TenantId', () => {
  const originalTenant = process.env.DEFAULT_TENANT_ID;

  afterEach(() => {
    if (originalTenant === undefined) delete process.env.DEFAULT_TENANT_ID;
    else process.env.DEFAULT_TENANT_ID = originalTenant;
  });

  it('returns the x-tenant-id header', () => {
    expect(tenantId(undefined, contextWith({ 'x-tenant-id': 'acme' }))).toBe('acme');
  });

  it('trims the header', () => {
    expect(tenantId(undefined, contextWith({ 'x-tenant-id': ' acme ' }))).toBe('acme');
  });

  it.each([
    ['missing', {}],
    ['empty', { 'x-tenant-id': '' }],
    ['whitespace only', { 'x-tenant-id': '  ' }],
  ])('falls back to the configured default tenant when the header is %s', (_label, headers) => {
    process.env.DEFAULT_TENANT_ID = 'default-tenant';
    expect(tenantId(undefined, contextWith(headers as Record<string, string>))).toBe('default-tenant');
  });

  it('falls back to an empty tenant when nothing is configured', () => {
    delete process.env.DEFAULT_TENANT_ID;
    expect(tenantId(undefined, contextWith({}))).toBe('');
  });
});

describe('@Public', () => {
  it('marks the handler so the API-key guard lets it through', () => {
    class Probe {
      @Public()
      route(): void {}
    }
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, Probe.prototype.route)).toBe(true);
  });
});
