/**
 * Call vocabulary (`FR-CALL-1..3`).
 *
 * Here because four consumers must agree: the log endpoint, the click-to-call port, the scoring
 * rule that reads a call's outcome, and the screens that offer the dropdown. The one decision worth
 * reading twice is the split between `status` and `outcome` — see below.
 */

/** Who rang whom. */
export const CALL_DIRECTIONS = ['outbound', 'inbound'] as const;
export type CallDirection = (typeof CALL_DIRECTIONS)[number];

/**
 * What the **telephony** says happened.
 *
 * `status` and `outcome_id` are both on a call and they are not the same thing, which is the
 * distinction the whole module turns on:
 *
 *  * **`status` is a fact about the connection** — it rang and nobody picked up, the line was busy,
 *    we spoke for four minutes. A provider reports it; with the manual driver the person reports it,
 *    and either way it is not a judgement.
 *  * **`outcome_id` is what the conversation *meant*** — interested, wants a callback, wrong number.
 *    It is tenant configuration (rule 4) because "not interested" is a different list in a school
 *    from a car dealership.
 *
 * Collapsing them would lose one or the other: a connected call with no useful outcome and a
 * no-answer with a "callback requested" outcome are both ordinary, and a single enum cannot say
 * either.
 */
export const CALL_STATUSES = ['dialing', 'completed', 'no_answer', 'busy', 'failed'] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

/**
 * The statuses that mean the call is over, whatever the result.
 *
 * A tuple of literals rather than `readonly CallStatus[]` so a Zod schema can be built straight
 * from it — the API's "a logged call is a call that is over" refusal and this list cannot then
 * drift apart. A spec asserts it is `CALL_STATUSES` minus `dialing`, which is what keeps a sixth
 * status from quietly becoming un-loggable.
 */
export const SETTLED_CALL_STATUSES = ['completed', 'no_answer', 'busy', 'failed'] as const;
export type SettledCallStatus = (typeof SETTLED_CALL_STATUSES)[number];

export function isSettledCallStatus(status: string): status is CallStatus {
  return (SETTLED_CALL_STATUSES as readonly string[]).includes(status);
}

/**
 * The machine-readable grouping behind a tenant's own outcome names
 * (`docs/database-design.md` §7).
 *
 * The names are rows and the categories are code, which is the same arrangement lead statuses use:
 * a workspace may call it "Spoke — keen" or "Hot", and the product still needs to know that one
 * means somebody actually talked to them.
 */
export const CALL_OUTCOME_CATEGORIES = [
  'connected',
  'no_answer',
  'busy',
  'wrong_number',
  'not_interested',
  'callback',
] as const;
export type CallOutcomeCategory = (typeof CALL_OUTCOME_CATEGORIES)[number];

/**
 * Whether a call in this category means somebody was **actually spoken to**.
 *
 * The one question the rest of the product asks of a call: it decides whether
 * `leads.first_contacted_at` gets written, whether the first-response SLA promise is satisfied, and
 * whether the lead counts as contacted on `/today` and `/oversight`. A ringing phone is not a
 * contact, however many times it rang — which is the whole reason "attempted" and "reached" have
 * to be different things in a CRM.
 *
 * Two of the six are easy to get wrong, in opposite directions:
 *
 *  * **`not_interested` is a contact.** A business that rang, got through and was turned down has
 *    answered the enquiry; counting that as "never responded" would hold its SLA against it for
 *    doing the job, and would leave the lead in the uncontacted queue for somebody to ring again.
 *  * **`wrong_number` is not.** Somebody was spoken to, but not *this person* — so the lead has
 *    still never been reached, and the number on the record is the thing that needs fixing.
 */
export function isContact(category: string): boolean {
  return category === 'connected' || category === 'callback' || category === 'not_interested';
}

/**
 * The connection status a chosen outcome implies.
 *
 * **Why a mapping exists at all.** `status` is what the telephony saw and `outcome` is what the
 * conversation meant — but with the manual driver there *is* no telephony, so the only source of
 * both is the person, and asking them twice ("did it connect?" and "what happened?") is asking the
 * same question in two vocabularies, one of them a developer's. So the screen asks once, for the
 * outcome, and derives the status from it. A provider driver reports the status itself and this is
 * not consulted.
 *
 * `wrong_number` maps to `completed` because somebody did answer — it just was not the person being
 * called, which is why `isContact` says no while this says the call connected. The two questions
 * are genuinely different and this is the one category where they diverge.
 *
 * `failed` is deliberately unreachable from here: it means the network could not place the call,
 * which only a provider can know.
 */
export function statusForCategory(category: CallOutcomeCategory): SettledCallStatus {
  switch (category) {
    case 'no_answer':
      return 'no_answer';
    case 'busy':
      return 'busy';
    default:
      return 'completed';
  }
}

export interface CallOutcomeSeed {
  readonly name: string;
  readonly category: CallOutcomeCategory;
  readonly sortOrder: number;
}

/**
 * What a workspace starts with, in the order somebody picks from them.
 *
 * Six, matching the six categories, because a seventh invented name is one the business has to
 * read and decide about before they can log their first call. They are rows, so the first thing a
 * dealership does is rename them.
 */
export const DEFAULT_CALL_OUTCOMES: readonly CallOutcomeSeed[] = [
  { name: 'Spoke — interested', category: 'connected', sortOrder: 10 },
  { name: 'Spoke — not interested', category: 'not_interested', sortOrder: 20 },
  { name: 'Asked to call back', category: 'callback', sortOrder: 30 },
  { name: 'No answer', category: 'no_answer', sortOrder: 40 },
  { name: 'Line busy', category: 'busy', sortOrder: 50 },
  { name: 'Wrong number', category: 'wrong_number', sortOrder: 60 },
];

/** The scoring trigger a logged call fires. Live, unlike the engagement triggers. */
export const CALL_LOGGED_EVENT = 'call.logged';

/**
 * How long a dialled call is left alone before the product asks what happened.
 *
 * Fifteen minutes: long enough that the nudge never arrives while somebody is still on the phone,
 * short enough that they still remember. The nudge is sent **once** per call (the notification's
 * own dedupe key is the record), because a second one is nagging and a third is why people turn
 * notifications off.
 */
export const CALL_OUTCOME_GRACE_MINUTES = 15;

/**
 * How far back the nudge sweep looks.
 *
 * A day. Past that nobody remembers the call, so there is nothing useful to ask — and the row stays
 * `dialing` for ever, which is the honest record of an attempt whose result was never known. It
 * also bounds what the sweep reads: without it, every un-recorded call in the platform's history
 * would be re-examined on every tick.
 */
export const CALL_OUTCOME_NUDGE_WINDOW_HOURS = 24;

/** A duration a human can read. Seconds below a minute, because a 40-second call is a fact. */
export function describeCallDuration(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return 'no time on the call';
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} sec`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hr ${minutes % 60} min`;
}

/**
 * The ceiling a logged duration is accepted up to: eight hours.
 *
 * Not a business rule — a typo guard. Somebody entering seconds into a minutes box, or a provider
 * reporting milliseconds, produces a call that would otherwise read as having lasted three weeks
 * and would poison every average built on it.
 */
export const MAX_CALL_SECONDS = 8 * 60 * 60;

export function isCallDuration(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_CALL_SECONDS;
}
