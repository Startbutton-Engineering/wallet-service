import type { Channel } from "amqplib";

export const DLQ_SUFFIX = '.dlq';
export const RETRY_HEADER = 'x-retry-count';

export const getDlqName = (queue: string) => `${queue}${DLQ_SUFFIX}`;

export async function assertQueueWithDlq(channel: Channel, queue: string, queueType: string): Promise<void> {
  const typeArgs = queueType ? { 'x-queue-type': queueType } : {};
  await channel.assertQueue(getDlqName(queue), { durable: true, arguments: typeArgs });
  await channel.assertQueue(queue, {
    durable: true,
    arguments: { ...typeArgs, 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': getDlqName(queue) },
  });
}
