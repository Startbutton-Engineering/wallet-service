import { Inject, Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { MESSAGE_QUEUE, QueueName } from "../queue/message-queue";
import type { MessageQueue } from "../queue/message-queue";
import { CutoverService } from "./cutover.service";

@Injectable()
export class CutoverConsumer implements OnApplicationBootstrap {
  constructor(
    @Inject(MESSAGE_QUEUE) private readonly queue: MessageQueue,
    private readonly cutovers: CutoverService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.consume(QueueName.LedgerCutover, (message, delivery) => this.cutovers.process(message, delivery));
  }
}
