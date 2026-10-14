import { Global, Module } from '@nestjs/common';
import { ManualTelephony } from './manual.telephony.js';
import { TELEPHONY } from './telephony.port.js';

/**
 * Telephony. Global because a call can be placed from the lead screen, the follow-up queue and
 * (later) the inbox, and none of them should own the driver.
 *
 * Only the manual driver exists. A cloud provider is a second class behind the same token selected
 * by a `TELEPHONY_DRIVER` setting — the port's job is to make that a one-line change here rather
 * than a change in every caller, which is what `FR-CALL-2` asks for.
 */
@Global()
@Module({
  providers: [{ provide: TELEPHONY, useClass: ManualTelephony }],
  exports: [TELEPHONY],
})
export class TelephonyModule {}
