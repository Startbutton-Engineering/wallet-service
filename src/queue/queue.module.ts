import { Global, Module } from "@nestjs/common";
import { MESSAGE_QUEUE } from "./message-queue";
import { RabbitMqQueue } from "./rabbitmq.queue";

@Global()
@Module({
  providers: [{ provide: MESSAGE_QUEUE, useClass: RabbitMqQueue }],
  exports: [MESSAGE_QUEUE],
})
export class QueueModule {}
