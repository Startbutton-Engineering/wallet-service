import { ArgumentsHost, CallHandler, ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Observable, of } from 'rxjs';

export interface MockHttpRequest {
  headers: Record<string, unknown>;
  header: jest.Mock<string | undefined, [string]>;
}

export interface MockHttpResponse {
  status: jest.Mock;
  json: jest.Mock;
  /** Whatever was handed to `res.json(...)`, for assertions on the response envelope. */
  body: unknown;
  statusCode?: number;
}

/** An express-ish request whose `header(name)` is case-insensitive, like the real one. */
export function mockRequest(headers: Record<string, string> = {}): MockHttpRequest {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = value;
  return {
    headers: lower,
    header: jest.fn((name: string) => lower[name.toLowerCase()]),
  };
}

export function mockResponse(): MockHttpResponse {
  const res = {} as MockHttpResponse;
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  return res;
}

export interface MockContextOptions {
  request?: MockHttpRequest;
  response?: MockHttpResponse;
  handler?: () => unknown;
  /** The controller class the route belongs to; `getClass()` returns it. */
  controller?: unknown;
}

export interface MockExecutionContext {
  request: MockHttpRequest;
  response: MockHttpResponse;
  /** The same object typed for the Nest APIs under test. */
  asContext: ExecutionContext;
  asHost: ArgumentsHost;
}

/** One stand-in covering ExecutionContext and ArgumentsHost — the guard, the interceptor,
 * the param decorators and the exception filter all reach for the same two accessors. */
export function mockExecutionContext(options: MockContextOptions = {}): MockExecutionContext {
  const request = options.request ?? mockRequest();
  const response = options.response ?? mockResponse();
  const handler = options.handler ?? (() => undefined);
  const controller = options.controller ?? class MockController {};

  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
      getNext: () => undefined,
    }),
    getHandler: () => handler,
    getClass: () => controller,
    getType: () => 'http',
    getArgs: () => [request, response],
    getArgByIndex: (index: number) => [request, response][index],
    switchToRpc: () => ({}),
    switchToWs: () => ({}),
  } as unknown as MockExecutionContext;

  context.request = request;
  context.response = response;
  context.asContext = context as unknown as ExecutionContext;
  context.asHost = context as unknown as ArgumentsHost;
  return context;
}

/** A CallHandler that emits `value` once, like a handler that returned it. */
export function mockCallHandler<T>(value: T): CallHandler<T> {
  return { handle: (): Observable<T> => of(value) };
}

/** A Reflector whose `getAllAndOverride` always answers `value`. */
export function mockReflector(value?: unknown): Reflector {
  return {
    getAllAndOverride: jest.fn(() => value),
    get: jest.fn(() => value),
  } as unknown as Reflector;
}

/** Pulls the factory out of a `createParamDecorator` result so it can be called directly.
 * Nest stores it in ROUTE_ARGS_METADATA when the decorator is applied to a parameter. */
export function paramDecoratorFactory(
  decorator: (...args: any[]) => ParameterDecorator,
): (data: unknown, ctx: ExecutionContext) => any {
  class Probe {
    // oxlint-disable-next-line no-unused-vars
    route(@decorator() _value: unknown): void {}
  }
  const metadata = Reflect.getMetadata(ROUTE_ARGS_METADATA, Probe, 'route');
  const [entry] = Object.values(metadata) as { factory: (data: unknown, ctx: ExecutionContext) => any }[];
  return entry.factory;
}
