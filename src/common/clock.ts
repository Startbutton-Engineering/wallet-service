import { Injectable } from "@nestjs/common";

export const CLOCK = Symbol('CLOCK');

/** The current time, injectable so scheduling and lease expiry can be tested without waiting. */
export interface Clock {
  now(): Date;
}

@Injectable()
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
