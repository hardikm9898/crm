/**
 * Telephony, behind a port so the provider is swappable (`FR-CALL-2`).
 *
 * The requirement is explicit: "Telephony MUST sit behind a provider abstraction so cloud
 * telephony, IVR, dialer, recording, transcription and AI summary can be added without touching CRM
 * core." So the contract is written from what the **CRM** needs, not from what any provider offers:
 *
 *  * **`dial` answers how the call will be placed, not that it was.** A cloud provider rings both
 *    parties server-side; the manual driver hands the number to the device. Those are genuinely
 *    different outcomes and the port says which happened, because the UI has to do something
 *    different in each case and a port that pretended they were the same would force every caller
 *    to guess.
 *  * **Nothing above the port writes a `calls` row.** `CallsService` does, before and after asking
 *    the port — so a provider failure leaves a logged attempt rather than nothing, and a provider
 *    that never arrives leaves a product that still works.
 *
 * What is deliberately **not** here:
 *
 *  * **Recordings, transcripts and summaries.** They arrive as provider webhooks on a call that
 *    already exists, so they are an update to a row, not a method on this port.
 *  * **A hangup.** Nothing in this product can end a call it did not place, and the manual driver
 *    could never implement it. A port method one driver has to throw from is a lie in the contract.
 */

export const TELEPHONY = Symbol('TELEPHONY');

export interface DialRequest {
  /** E.164. The person being called. */
  readonly to: string;
  /** E.164, the agent's own line, when the workspace knows it. */
  readonly from?: string;
  /** Our call row's id, so a provider's webhook can be matched back to it. */
  readonly callId: string;
}

/**
 * How the call is being placed.
 *
 * `device` means "we did not place it — open this link and the phone will". That is not a failure
 * mode: it is the honest answer for every workspace that has not connected a telephony provider,
 * which is all of them today, and it is what makes click-to-call useful before anybody buys a plan.
 */
export type DialOutcome =
  | {
      readonly mode: 'device';
      /** `tel:+919845012345`, for the client to open. */
      readonly href: string;
    }
  | {
      readonly mode: 'provider';
      readonly provider: string;
      /** The provider's own id, stored so its webhooks can find the call. */
      readonly providerCallId: string;
    };

export interface TelephonyPort {
  /** Which driver is in use, for the health endpoint and the operator console. */
  readonly driver: string;
  /**
   * Whether this driver can place a call itself.
   *
   * Read by the API so the screen can say "this opens your phone" rather than implying the product
   * is dialling, and read by the permission-independent half of the UI to decide what to render.
   */
  readonly placesCalls: boolean;
  dial(request: DialRequest): Promise<DialOutcome>;
}
