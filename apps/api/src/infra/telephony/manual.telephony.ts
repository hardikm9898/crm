import { Injectable } from '@nestjs/common';
import { AppError } from '@leados/shared';
import type { DialOutcome, DialRequest, TelephonyPort } from './telephony.port.js';

/**
 * The driver every workspace has until it connects a provider: the device places the call.
 *
 * Not a stub. A `tel:` link on a phone is how a sales executive actually dials, and the valuable
 * half of click-to-call is not the dialling — it is that the product **knows an attempt was made**,
 * so the lead's history has a row and the follow-up can be closed against it. A provider adds
 * recording, IVR and a server-side leg; it does not add the thing that makes the feature worth
 * having.
 */
@Injectable()
export class ManualTelephony implements TelephonyPort {
  readonly driver = 'manual';
  /** False, and the API says so in its answer: nothing here places a call. */
  readonly placesCalls = false;

  async dial(request: DialRequest): Promise<DialOutcome> {
    // E.164 or nothing: `tel:` with a half-typed number opens the dialler on rubbish, and the
    // `calls_to_e164_format` check would refuse the row we are about to write anyway.
    if (!/^\+[1-9][0-9]{6,19}$/.test(request.to)) {
      throw AppError.validation('That is not a phone number this product can dial', []);
    }
    return { mode: 'device', href: `tel:${request.to}` };
  }
}
