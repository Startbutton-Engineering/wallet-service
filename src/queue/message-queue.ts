export const MESSAGE_QUEUE = Symbol('MESSAGE_QUEUE');

export enum QueueName {
  LedgerCutover = 'wallet-service.ledger-cutover',
}

export interface Delivery {
  retries: number;
  lastAttempt: boolean;
}

export type QueueHandler = (message: unknown, delivery: Delivery) => Promise<void>;

export interface MessageQueue {
  publish(queue: QueueName, message: unknown): Promise<void>;
  consume(queue: QueueName, handler: QueueHandler): Promise<void>;
}
