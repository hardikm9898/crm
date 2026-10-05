import { Global, Module } from '@nestjs/common';
import { LocalDiskStorage } from './local-disk.storage.js';
import { STORAGE } from './storage.port.js';

/**
 * File storage. Global because documents are created by several modules (imports, exports, and
 * later attachments and website media) and none of them should own the driver.
 *
 * Only the local driver exists today. The S3 driver is a second class behind the same token
 * selected by `STORAGE_DRIVER` — the port's job is to make that a one-line change here rather than
 * a change in every caller.
 */
@Global()
@Module({
  providers: [{ provide: STORAGE, useClass: LocalDiskStorage }],
  exports: [STORAGE],
})
export class StorageModule {}
