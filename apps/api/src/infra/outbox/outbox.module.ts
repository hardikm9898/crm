import { Global, Module } from '@nestjs/common';
import { OutboxDispatcherService } from './outbox-dispatcher.service.js';
import { OutboxService } from './outbox.service.js';

@Global()
@Module({
  providers: [OutboxService, OutboxDispatcherService],
  exports: [OutboxService, OutboxDispatcherService],
})
export class OutboxModule {}
