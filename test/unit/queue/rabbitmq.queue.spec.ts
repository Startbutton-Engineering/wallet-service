jest.mock('amqplib', () => ({ connect: jest.fn() }));

import { EventEmitter } from 'events';
import { Logger } from '@nestjs/common';
import { connect } from 'amqplib';
import type { ConsumeMessage } from 'amqplib';
import { loadConfig } from '../../../src/config';
import { ErrorCode } from '../../../src/common/errors';
import { QueueName } from '../../../src/queue/message-queue';
import { MAX_RETRIES, RabbitMqQueue, RECONNECT_MS, retryDelayMs } from '../../../src/queue/rabbitmq.queue';
import { assertQueueWithDlq, getDlqName, RETRY_HEADER } from '../../../src/queue/dlq';

const connectMock = connect as unknown as jest.Mock;
const QUEUE = QueueName.LedgerCutover;

class FakeChannel extends EventEmitter {
  assertQueue = jest.fn(async () => ({}));
  prefetch = jest.fn(async () => undefined);
  sendToQueue = jest.fn(() => true);
  waitForConfirms = jest.fn(async () => undefined);
  ack = jest.fn();
  nack = jest.fn();
  cancel = jest.fn(async () => ({}));
  deliver: ((msg: ConsumeMessage | null) => void) | null = null;
  consume = jest.fn(async (_queue: string, onMessage: (msg: ConsumeMessage | null) => void) => {
    this.deliver = onMessage;
    return { consumerTag: 'tag-1' };
  });
}

class FakeConnection extends EventEmitter {
  channels: FakeChannel[] = [];
  confirmChannels: FakeChannel[] = [];
  createChannel = jest.fn(async () => {
    const channel = new FakeChannel();
    this.channels.push(channel);
    return channel;
  });
  createConfirmChannel = jest.fn(async () => {
    const channel = new FakeChannel();
    this.confirmChannels.push(channel);
    return channel;
  });
  close = jest.fn(async () => undefined);
}

const message = (body: string, retries?: number) =>
  ({ content: Buffer.from(body), properties: { headers: retries === undefined ? {} : { [RETRY_HEADER]: retries } } }) as unknown as ConsumeMessage;

const queueWith = (env: Record<string, string> = { RABBITMQ_URL: 'amqps://user:pass@broker.example:5671/vhost' }) =>
  new RabbitMqQueue(loadConfig(env as NodeJS.ProcessEnv));

/** Lets the consumer callback's promise chain run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('RabbitMqQueue', () => {
  let connection: FakeConnection;

  beforeEach(() => {
    connection = new FakeConnection();
    connectMock.mockReset().mockResolvedValue(connection);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('publish', () => {
    it('sends a persistent JSON message on a confirm channel and waits for the broker to take it', async () => {
      const queue = queueWith();

      await queue.publish(QUEUE, { operationId: 'op-1' });

      expect(connectMock).toHaveBeenCalledWith('amqps://user:pass@broker.example:5671/vhost?heartbeat=60', { servername: 'broker.example' });
      const [channel] = connection.confirmChannels;
      expect(channel.sendToQueue).toHaveBeenCalledWith(QUEUE, Buffer.from('{"operationId":"op-1"}'), {
        persistent: true, contentType: 'application/json', headers: {},
      });
      expect(channel.waitForConfirms).toHaveBeenCalled();
    });

    it('leaves the TLS server name unset when the URL names no host', async () => {
      await queueWith({ RABBITMQ_URL: 'amqp:///vhost' }).publish(QUEUE, {});
      expect(connectMock).toHaveBeenCalledWith('amqp:///vhost?heartbeat=60', { servername: undefined });
    });

    it('declares the queue and its DLQ once, then reuses the connection and channel', async () => {
      const queue = queueWith();

      await queue.publish(QUEUE, { n: 1 });
      await queue.publish(QUEUE, { n: 2 });

      expect(connectMock).toHaveBeenCalledTimes(1);
      expect(connection.createConfirmChannel).toHaveBeenCalledTimes(1);
      expect(connection.confirmChannels[0].assertQueue).toHaveBeenCalledTimes(2);
    });

    it('refuses with a retryable 503 when no broker is configured', async () => {
      await expect(queueWith({}).publish(QUEUE, {})).rejects.toMatchObject({
        code: ErrorCode.SERVICE_UNAVAILABLE, retryable: true, details: { reason: 'RABBITMQ_URL is not set' },
      });
      expect(connectMock).not.toHaveBeenCalled();
    });

    it('refuses with a retryable 503 when the broker cannot be reached, and connects afresh next time', async () => {
      connectMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const queue = queueWith();

      await expect(queue.publish(QUEUE, {})).rejects.toMatchObject({ code: ErrorCode.SERVICE_UNAVAILABLE, details: { reason: 'ECONNREFUSED' } });
      await queue.publish(QUEUE, {});

      expect(connectMock).toHaveBeenCalledTimes(2);
    });

    it('opens a new publisher channel when the channel cannot be created or has closed', async () => {
      connection.createConfirmChannel.mockRejectedValueOnce('channel limit');
      const queue = queueWith();

      await expect(queue.publish(QUEUE, {})).rejects.toMatchObject({ details: { reason: 'channel limit' } });
      await queue.publish(QUEUE, {});
      connection.confirmChannels[0].emit('error', new Error('PRECONDITION_FAILED'));
      connection.confirmChannels[0].emit('close');
      await queue.publish(QUEUE, {});

      expect(connection.createConfirmChannel).toHaveBeenCalledTimes(3);
    });

    it('refuses when the broker does not confirm the message', async () => {
      const queue = queueWith();
      await queue.publish(QUEUE, {});
      connection.confirmChannels[0].waitForConfirms.mockRejectedValueOnce(new Error('nack'));

      await expect(queue.publish(QUEUE, {})).rejects.toMatchObject({ code: ErrorCode.SERVICE_UNAVAILABLE });
    });
  });

  describe('consume', () => {
    async function consuming(handler = jest.fn(async () => undefined), queue = queueWith()) {
      await queue.consume(QUEUE, handler);
      return { queue, handler, channel: connection.channels.at(-1)! };
    }

    it('takes one message at a time from the queue and its DLQ setup', async () => {
      const { channel } = await consuming();

      expect(channel.prefetch).toHaveBeenCalledWith(1);
      expect(channel.assertQueue).toHaveBeenCalledWith(getDlqName(QUEUE), expect.anything());
      expect(channel.consume).toHaveBeenCalledWith(QUEUE, expect.any(Function));
    });

    it('does nothing without a broker', async () => {
      await queueWith({}).consume(QUEUE, jest.fn());
      expect(connectMock).not.toHaveBeenCalled();
    });

    it('acks a handled message, passing the parsed body and the attempt', async () => {
      const { channel, handler } = await consuming();
      const msg = message('{"operationId":"op-1"}');

      channel.deliver!(msg);
      channel.deliver!(null);
      await flush();

      expect(handler).toHaveBeenCalledWith({ operationId: 'op-1' }, { retries: 0, lastAttempt: false });
      expect(channel.ack).toHaveBeenCalledWith(msg);
    });

    it('dead-letters an unreadable message without calling the handler', async () => {
      const { channel, handler } = await consuming();
      const msg = message('not json');

      channel.deliver!(msg);
      await flush();

      expect(handler).not.toHaveBeenCalled();
      expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    });

    it('retries a failed message after a backoff, with the retry count, then acks the original', async () => {
      jest.useFakeTimers();
      const { channel } = await consuming(jest.fn(async () => Promise.reject(new Error('mongo down'))));
      const msg = message('{"n":1}', 1);

      channel.deliver!(msg);
      await jest.advanceTimersByTimeAsync(retryDelayMs(1) - 1);
      expect(connection.confirmChannels).toHaveLength(0);
      await jest.advanceTimersByTimeAsync(1);

      expect(connection.confirmChannels[0].sendToQueue).toHaveBeenCalledWith(QUEUE, Buffer.from('{"n":1}'), expect.objectContaining({
        headers: { [RETRY_HEADER]: 2 },
      }));
      expect(channel.ack).toHaveBeenCalledWith(msg);
    });

    it('puts the original back when the retry cannot be published', async () => {
      jest.useFakeTimers();
      const { channel } = await consuming(jest.fn(async () => Promise.reject('down')));
      connection.createConfirmChannel.mockRejectedValueOnce(new Error('closed'));
      const msg = message('{"n":1}');

      channel.deliver!(msg);
      await jest.advanceTimersByTimeAsync(retryDelayMs(0));

      expect(channel.nack).toHaveBeenCalledWith(msg, false, true);
    });

    it('dead-letters a message that fails its last attempt', async () => {
      const handler = jest.fn(async () => Promise.reject(new Error('still broken')));
      const { channel } = await consuming(handler);
      const msg = message('{"n":1}', MAX_RETRIES);

      channel.deliver!(msg);
      await flush();

      expect(handler).toHaveBeenCalledWith({ n: 1 }, { retries: MAX_RETRIES, lastAttempt: true });
      expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    });

    it('ignores an ack on a channel that has already closed', async () => {
      const { channel } = await consuming();
      channel.ack.mockImplementation(() => {
        throw new Error('Channel closed');
      });

      channel.deliver!(message('{}'));
      await flush();

      expect(channel.ack).toHaveBeenCalled();
    });

    it('keeps retrying to start the consumer while the broker is unreachable', async () => {
      jest.useFakeTimers();
      connectMock.mockRejectedValueOnce(new Error('ECONNREFUSED')).mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await queueWith().consume(QUEUE, jest.fn());

      await jest.advanceTimersByTimeAsync(RECONNECT_MS);
      expect(connection.channels).toHaveLength(0);
      await jest.advanceTimersByTimeAsync(RECONNECT_MS);

      expect(connectMock).toHaveBeenCalledTimes(3);
      expect(connection.channels).toHaveLength(1);
    });

    it('re-attaches the consumer after the connection drops', async () => {
      jest.useFakeTimers();
      const { channel } = await consuming();
      const second = new FakeConnection();
      connectMock.mockResolvedValueOnce(second);

      connection.emit('error', new Error('heartbeat timeout'));
      connection.emit('close');
      channel.emit('close');
      await jest.advanceTimersByTimeAsync(RECONNECT_MS);

      expect(second.channels).toHaveLength(1);
      expect(second.channels[0].consume).toHaveBeenCalledWith(QUEUE, expect.any(Function));
    });

    it('re-attaches the consumer after only its channel closes', async () => {
      jest.useFakeTimers();
      const { channel } = await consuming();

      channel.emit('error', new Error('PRECONDITION_FAILED'));
      channel.emit('close');
      await jest.advanceTimersByTimeAsync(RECONNECT_MS);

      expect(connection.channels).toHaveLength(2);
      expect(connectMock).toHaveBeenCalledTimes(1);
    });

    it('does not start a second consumer for a queue it already consumes', async () => {
      const { queue, handler } = await consuming();
      await queue.consume(QUEUE, handler);
      expect(connection.channels).toHaveLength(1);
    });
  });

  describe('beforeApplicationShutdown', () => {
    it('stops consuming, lets the message in hand finish, then closes without reconnecting', async () => {
      jest.useFakeTimers();
      let finish!: () => void;
      const handler = jest.fn(() => new Promise<void>((resolve) => (finish = resolve)));
      const queue = queueWith();
      await queue.consume(QUEUE, handler);
      const [channel] = connection.channels;
      channel.deliver!(message('{}'));

      const shutdown = queue.beforeApplicationShutdown();
      await jest.advanceTimersByTimeAsync(0);
      expect(channel.cancel).toHaveBeenCalledWith('tag-1');
      expect(connection.close).not.toHaveBeenCalled();
      finish();
      await shutdown;
      connection.emit('close');
      await jest.advanceTimersByTimeAsync(RECONNECT_MS);

      expect(channel.ack).toHaveBeenCalled();
      expect(connection.close).toHaveBeenCalled();
      expect(connectMock).toHaveBeenCalledTimes(1);
    });

    it('closes even when the broker errors on cancel or close, and does not re-attach closed channels', async () => {
      jest.useFakeTimers();
      const queue = queueWith();
      await queue.consume(QUEUE, jest.fn());
      const [channel] = connection.channels;
      channel.cancel.mockRejectedValueOnce(new Error('gone'));
      connection.close.mockRejectedValueOnce(new Error('gone'));

      await queue.beforeApplicationShutdown();
      channel.emit('close');
      await jest.advanceTimersByTimeAsync(RECONNECT_MS);

      expect(connection.close).toHaveBeenCalled();
      expect(connection.channels).toHaveLength(1);
    });

    it('cancels a pending reconnect and copes with never having connected', async () => {
      jest.useFakeTimers();
      connectMock.mockRejectedValue(new Error('ECONNREFUSED'));
      const queue = queueWith();
      await queue.consume(QUEUE, jest.fn());

      await queue.beforeApplicationShutdown();
      await jest.advanceTimersByTimeAsync(RECONNECT_MS);

      expect(connectMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe('assertQueueWithDlq', () => {
  it('declares the DLQ, then the queue dead-lettering into it, both of the configured type', async () => {
    const channel = new FakeChannel();

    await assertQueueWithDlq(channel as never, 'jobs', 'quorum');

    expect(channel.assertQueue.mock.calls).toEqual([
      ['jobs.dlq', { durable: true, arguments: { 'x-queue-type': 'quorum' } }],
      ['jobs', { durable: true, arguments: { 'x-queue-type': 'quorum', 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': 'jobs.dlq' } }],
    ]);
  });

  it('leaves the queue type to the broker when none is configured', async () => {
    const channel = new FakeChannel();

    await assertQueueWithDlq(channel as never, 'jobs', '');

    expect(channel.assertQueue.mock.calls[0]).toEqual(['jobs.dlq', { durable: true, arguments: {} }]);
  });
});
