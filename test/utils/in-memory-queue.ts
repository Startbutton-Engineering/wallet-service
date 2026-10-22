import type { Delivery, MessageQueue, QueueHandler, QueueName } from "../../src/queue/message-queue";

/** Holds published messages until `drain()`, so a test sees the state between request and processing. */
export class InMemoryQueue implements MessageQueue {
  readonly published: { queue: QueueName; message: unknown }[] = [];
  private readonly pending: { queue: QueueName; message: unknown }[] = [];
  private readonly handlers = new Map<QueueName, QueueHandler>();

  async publish(queue: QueueName, message: unknown): Promise<void> {
    // A copy, as the broker would deliver it.
    const copy = JSON.parse(JSON.stringify(message));
    this.published.push({ queue, message: copy });
    this.pending.push({ queue, message: copy });
  }

  async consume(queue: QueueName, handler: QueueHandler): Promise<void> {
    this.handlers.set(queue, handler);
  }

  /** Delivers everything queued so far, and anything published meanwhile, as a final attempt. */
  async drain(delivery: Delivery = { retries: 0, lastAttempt: true }): Promise<void> {
    for (let next = this.pending.shift(); next; next = this.pending.shift()) {
      const handler = this.handlers.get(next.queue);
      if (!handler) throw new Error(`No consumer registered for "${next.queue}"`);
      await handler(next.message, delivery);
    }
  }
}
