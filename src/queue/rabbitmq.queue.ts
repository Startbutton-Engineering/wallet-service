import { BeforeApplicationShutdown, Inject, Injectable, Logger } from "@nestjs/common";
import { connect } from "amqplib";
import type { Channel, ChannelModel, ConfirmChannel, ConsumeMessage } from "amqplib";
import { CONFIG } from "../config";
import type { AppConfig } from "../config";
import { AppError } from "../common/errors";
import { assertQueueWithDlq, RETRY_HEADER } from "./dlq";
import { MessageQueue, QueueHandler, QueueName } from "./message-queue";

export const MAX_RETRIES = 3;
export const RECONNECT_MS = 5000;
/** 1s, 2s, 4s: the message stays unacked meanwhile, so a crash redelivers it rather than losing it. */
export const retryDelayMs = (retries: number) => 2 ** retries * 1000;

/**
 * One connection per process: a confirm channel for publishing, and one channel per consumed queue
 * (prefetch 1). Consumers are re-attached after the connection or their channel drops.
 */
@Injectable()
export class RabbitMqQueue implements MessageQueue, BeforeApplicationShutdown {
  private readonly logger = new Logger('RabbitMQ');
  private connection: Promise<ChannelModel> | null = null;
  private publisher: Promise<ConfirmChannel> | null = null;
  private readonly asserted = new Set<string>();
  private readonly handlers = new Map<QueueName, QueueHandler>();
  private readonly consumers = new Map<QueueName, { channel: Channel; consumerTag: string }>();
  private readonly inFlight = new Set<Promise<void>>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closing = false;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  async publish(queue: QueueName, message: unknown, headers: Record<string, unknown> = {}): Promise<void> {
    if (!this.config.rabbitMq.url) throw AppError.queueUnavailable('RABBITMQ_URL is not set');
    try {
      const channel = await this.publisherChannel();
      await this.assertQueue(channel, queue);
      channel.sendToQueue(queue, Buffer.from(JSON.stringify(message)), { persistent: true, contentType: 'application/json', headers });
      await channel.waitForConfirms();
    } catch (err) {
      this.logger.error(`Could not publish to "${queue}": ${errorMessage(err)}`);
      throw AppError.queueUnavailable(errorMessage(err));
    }
  }

  async consume(queue: QueueName, handler: QueueHandler): Promise<void> {
    if (!this.config.rabbitMq.url) {
      this.logger.warn(`RABBITMQ_URL is not set: "${queue}" is not consumed`);
      return;
    }
    this.handlers.set(queue, handler);
    await this.startConsumer(queue, handler).catch((err) => {
      this.logger.error(`Could not start the "${queue}" consumer: ${errorMessage(err)}`);
      this.scheduleReconnect();
    });
  }

  /** Stops taking messages and lets the ones in hand finish, before Mongo and the connection close. */
  async beforeApplicationShutdown(): Promise<void> {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const { channel, consumerTag } of this.consumers.values()) await channel.cancel(consumerTag).catch(() => undefined);
    await Promise.allSettled(this.inFlight);
    const connection = await this.connection?.catch(() => null);
    await connection?.close().catch(() => undefined);
    this.connection = null;
  }

  private getConnection(): Promise<ChannelModel> {
    this.connection ??= this.openConnection().catch((err) => {
      this.connection = null;
      throw err;
    });
    return this.connection;
  }

  private async openConnection(): Promise<ChannelModel> {
    const url = new URL(this.config.rabbitMq.url);
    url.searchParams.set('heartbeat', '60');
    const connection = await connect(url.toString(), { servername: url.hostname || undefined });
    connection.on('error', (err: Error) => this.logger.error(`Connection error: ${err.message}`));
    connection.on('close', () => {
      this.connection = null;
      this.publisher = null;
      this.asserted.clear();
      this.consumers.clear();
      if (this.closing) return;
      this.logger.warn('Connection closed, reconnecting');
      this.scheduleReconnect();
    });
    this.logger.log('Connected to RabbitMQ');
    return connection;
  }

  private publisherChannel(): Promise<ConfirmChannel> {
    this.publisher ??= this.getConnection()
      .then(async (connection) => {
        const channel = await connection.createConfirmChannel();
        channel.on('error', (err: Error) => this.logger.error(`Publisher channel error: ${err.message}`));
        channel.on('close', () => {
          this.publisher = null;
        });
        return channel;
      })
      .catch((err) => {
        this.publisher = null;
        throw err;
      });
    return this.publisher;
  }

  private async assertQueue(channel: Channel, queue: string): Promise<void> {
    if (this.asserted.has(queue)) return;
    await assertQueueWithDlq(channel, queue, this.config.rabbitMq.queueType);
    this.asserted.add(queue);
  }

  private async startConsumer(queue: QueueName, handler: QueueHandler): Promise<void> {
    if (this.consumers.has(queue)) return;
    const connection = await this.getConnection();
    const channel = await connection.createChannel();
    channel.on('error', (err: Error) => this.logger.error(`"${queue}" channel error: ${err.message}`));
    channel.on('close', () => {
      this.consumers.delete(queue);
      if (!this.closing) this.scheduleReconnect();
    });
    await assertQueueWithDlq(channel, queue, this.config.rabbitMq.queueType);
    await channel.prefetch(1);
    const { consumerTag } = await channel.consume(queue, (msg) => {
      if (!msg) return;
      const done = this.deliver(channel, queue, handler, msg).finally(() => this.inFlight.delete(done));
      this.inFlight.add(done);
    });
    this.consumers.set(queue, { channel, consumerTag });
    this.logger.log(`Consuming "${queue}"`);
  }

  private async deliver(channel: Channel, queue: QueueName, handler: QueueHandler, msg: ConsumeMessage): Promise<void> {
    const retries = Number(msg.properties.headers?.[RETRY_HEADER] ?? 0);
    let message: unknown;
    try {
      message = JSON.parse(msg.content.toString());
    } catch {
      this.logger.error(`Dead-lettering an unreadable message on "${queue}"`);
      return settle(() => channel.nack(msg, false, false));
    }

    try {
      await handler(message, { retries, lastAttempt: retries >= MAX_RETRIES });
      return settle(() => channel.ack(msg));
    } catch (err) {
      if (retries >= MAX_RETRIES) {
        this.logger.error(`"${queue}" failed after ${retries + 1} attempts, dead-lettering: ${errorMessage(err)}`);
        return settle(() => channel.nack(msg, false, false));
      }
      this.logger.warn(`"${queue}" attempt ${retries + 1} failed, retrying: ${errorMessage(err)}`);
    }

    await new Promise((resolve) => setTimeout(resolve, retryDelayMs(retries)));
    try {
      // Published before the ack: a crash in between delivers twice, which handlers absorb, rather than never.
      await this.publish(queue, message, { [RETRY_HEADER]: retries + 1 });
      settle(() => channel.ack(msg));
    } catch {
      settle(() => channel.nack(msg, false, true));
    }
  }

  private scheduleReconnect(): void {
    if (this.closing || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      for (const [queue, handler] of this.handlers) {
        this.startConsumer(queue, handler).catch((err) => {
          this.logger.error(`Could not restart the "${queue}" consumer: ${errorMessage(err)}`);
          this.scheduleReconnect();
        });
      }
    }, RECONNECT_MS);
  }
}

/** An ack or nack on a channel that has since closed throws; the broker redelivers that message anyway. */
function settle(action: () => void): void {
  try {
    action();
  } catch {
    // Channel closed: nothing left to settle.
  }
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
