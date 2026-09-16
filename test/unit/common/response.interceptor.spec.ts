import { lastValueFrom } from 'rxjs';
import { ResponseInterceptor } from '../../../src/common/response.interceptor';
import { DEFAULT_SUCCESS_MESSAGE, RESPONSE_MESSAGE_KEY, ResponseMessage } from '../../../src/common/api-response';
import { mockCallHandler, mockExecutionContext, mockReflector } from '../../mocks';

describe('ResponseInterceptor', () => {
  const intercept = async (reflected: unknown, value: unknown) => {
    const interceptor = new ResponseInterceptor<unknown>(mockReflector(reflected));
    return lastValueFrom(
      interceptor.intercept(mockExecutionContext().asContext, mockCallHandler(value)),
    );
  };

  it('wraps the handler value in the success envelope', async () => {
    await expect(intercept('Wallet created', { ownerId: 'm1' })).resolves.toEqual({
      success: true,
      message: 'Wallet created',
      data: { ownerId: 'm1' },
    });
  });

  it('falls back to the default message when the route sets none', async () => {
    await expect(intercept(undefined, [])).resolves.toEqual({
      success: true,
      message: DEFAULT_SUCCESS_MESSAGE,
      data: [],
    });
  });

  it('normalises undefined data to null so the envelope always has a `data` key', async () => {
    await expect(intercept('ok', undefined)).resolves.toEqual({
      success: true,
      message: 'ok',
      data: null,
    });
  });

  it.each([
    ['zero', 0],
    ['empty string', ''],
    ['false', false],
  ])('keeps the falsy-but-present value %s', async (_label, value) => {
    await expect(intercept('ok', value)).resolves.toMatchObject({ data: value });
  });

  it('reads the message from both the handler and the controller class', async () => {
    const reflector = mockReflector('Currencies retrieved');
    const interceptor = new ResponseInterceptor<unknown>(reflector);
    const context = mockExecutionContext();

    await lastValueFrom(interceptor.intercept(context.asContext, mockCallHandler([])));

    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(RESPONSE_MESSAGE_KEY, [
      context.asContext.getHandler(),
      context.asContext.getClass(),
    ]);
  });
});

describe('ResponseMessage', () => {
  it('stores the message under the key the interceptor reads', () => {
    class Probe {
      @ResponseMessage('Wallet created')
      route(): void {}
    }
    expect(Reflect.getMetadata(RESPONSE_MESSAGE_KEY, Probe.prototype.route)).toBe('Wallet created');
  });
});
