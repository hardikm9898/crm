/**
 * The shared inbox's own rules (`FR-WA-7`, `FR-WA-10`).
 *
 * Its own module rather than more of `whatsapp.ts` for two reasons. A conversation is not a
 * WhatsApp concept — `conversations.channel` already names email, sms and webchat — and
 * `@leados/shared` is **one barrel**, so a file per vocabulary is what keeps a generic name like
 * `LockState` from colliding with somebody else's.
 *
 * Everything here is pure, because both halves of the product read it: the write path refuses with
 * these functions and the screen decides what to offer with the same ones. A screen that computes
 * its own answer is how "the button was enabled and the action was refused" happens.
 */

/**
 * How long a soft lock lasts (`FR-WA-7`'s ownership lock).
 *
 * Five minutes, and short on purpose. The lock exists so two agents do not answer one customer
 * twice; it is **not** ownership, which is `assigned_user_id`. An agent who opens a conversation,
 * is called away and never comes back must not hold it: the cost of a lock that outlives attention
 * is a customer nobody answers, which is worse than two people typing. Refreshed by every reply,
 * so somebody actually working keeps it without thinking about it.
 */
export const CONVERSATION_LOCK_TTL_MS = 5 * 60_000;

/** A lock, as both the screen and the write path read it. */
export interface ConversationLockState {
  /** Whether anybody holds it **now**. An expired lock is not held. */
  readonly held: boolean;
  /** Whether the viewer is the holder, which is the only case that may reply freely. */
  readonly mine: boolean;
  /** When it lapses, for a screen that wants to count down. Null when nobody holds it. */
  readonly expiresAt: Date | null;
  /**
   * What a person reads, or null when there is nothing to say.
   *
   * Written from the viewer's side: "You have this open" is a reassurance and "Nikhil opened this
   * four minutes ago" is a warning, and a single sentence for both would be neither.
   */
  readonly message: string | null;
}

/**
 * The one decider for "may I answer this without stepping on somebody".
 *
 * **Advisory, not a refusal.** A reply by somebody who is not the holder is allowed and says so,
 * because the alternative is a customer waiting while the person who opened the conversation is at
 * lunch. `FR-WA-7` asks that two agents on one conversation *see* each other, which is a sentence
 * on a screen rather than a 422 — and the audit trail is what makes a transfer accountable.
 */
export function conversationLock(input: {
  readonly lockUserId: string | null;
  readonly lockExpiresAt: Date | null;
  readonly lockHolderName: string | null;
  readonly viewerId: string;
  readonly now?: Date;
}): ConversationLockState {
  const now = input.now ?? new Date();
  const live =
    input.lockUserId !== null &&
    input.lockExpiresAt !== null &&
    input.lockExpiresAt.getTime() > now.getTime();
  if (!live) return { held: false, mine: false, expiresAt: null, message: null };
  const mine = input.lockUserId === input.viewerId;
  return {
    held: true,
    mine,
    expiresAt: input.lockExpiresAt,
    message: mine
      ? 'You have this conversation open.'
      : `${input.lockHolderName ?? 'Somebody'} opened this ${describeAgo(
          input.lockExpiresAt!.getTime() - CONVERSATION_LOCK_TTL_MS,
          now,
        )} — check with them before replying.`,
  };
}

/** "just now", "4 minutes ago". Small, and only ever used in the sentence above. */
function describeAgo(takenAtMs: number, now: Date): string {
  const minutes = Math.floor((now.getTime() - takenAtMs) / 60_000);
  if (minutes <= 0) return 'just now';
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
}

/** When a lock taken now would lapse. */
export function conversationLockExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + CONVERSATION_LOCK_TTL_MS);
}

/**
 * Whether a conversation may be snoozed until this instant, and why not.
 *
 * A snooze is a promise to come back, so an instant in the past is a promise already broken — and
 * one a year out is a conversation nobody will ever see again, which is what `closed` is for.
 */
export function snoozeProblem(until: Date, now: Date = new Date()): string | null {
  if (Number.isNaN(until.getTime())) return 'That is not a time.';
  if (until.getTime() <= now.getTime()) {
    return 'Choose a time in the future — a snooze until the past would bring it straight back.';
  }
  if (until.getTime() - now.getTime() > MAX_SNOOZE_MS) {
    return 'Up to 30 days. Anything longer is really a conversation to close.';
  }
  return null;
}

const MAX_SNOOZE_MS = 30 * 24 * 60 * 60_000;

/**
 * The words a customer uses to stop being messaged, and to start again (`FR-WA-10`).
 *
 * Meta publishes no list, so this is the industry's: what somebody types when they want it to
 * stop. Matched on the **whole message**, trimmed and case-folded, and not on a message that
 * merely contains the word — "please stop sending me the wrong floor plan" is a complaint about a
 * file, not a withdrawal of consent, and reading it as one would silence a customer mid-conversation
 * for a reason nobody could find afterwards.
 */
export const CONSENT_OPT_OUT_WORDS: readonly string[] = [
  'stop',
  'unsubscribe',
  'optout',
  'opt out',
  'opt-out',
  'remove me',
  'do not message',
  "don't message",
];

/**
 * Deliberately **not** on that list: `no`, `cancel`, `end` and `quit`.
 *
 * Each appears on somebody's published opt-out list, and each is a word a customer uses in the
 * middle of an ordinary conversation — "no" answers "would Saturday suit?", and "cancel" is about
 * an appointment far more often than about marketing. A false positive here silences a customer
 * **invisibly**: nothing on any screen says why they stopped getting messages, and the one person
 * who could explain it is the customer. The error that costs a marketing message is cheaper than
 * the error that costs a relationship, so the list is short and the words on it are unambiguous.
 */

/** And the words that undo it. Meta's own `START`/`UNSTOP`, plus what people actually write. */
export const CONSENT_OPT_IN_WORDS: readonly string[] = [
  'start',
  'unstop',
  'subscribe',
  'resume',
  'optin',
  'opt in',
  'opt-in',
];

export type ConsentKeyword = 'opt_out' | 'opt_in';

/**
 * What this message says about consent, if anything.
 *
 * `null` for everything that is not one of these words exactly — which is almost every message,
 * and the honest default: a keyword rule that guesses takes away somebody's ability to be
 * contacted, and nothing on the screen would explain why.
 */
export function consentKeyword(body: string | null): ConsentKeyword | null {
  if (body === null) return null;
  // Punctuation and emoji trimmed: "STOP." and "stop!" are the same intention, and a trailing
  // full stop deciding whether a customer is silenced would be absurd.
  const word = body
    .trim()
    .toLowerCase()
    .replace(/[.!?,;:\s]+$/u, '')
    .replace(/^[.!?,;:\s]+/u, '');
  if (word === '') return null;
  if (CONSENT_OPT_OUT_WORDS.includes(word)) return 'opt_out';
  if (CONSENT_OPT_IN_WORDS.includes(word)) return 'opt_in';
  return null;
}

/** What a workspace tells the customer it has done, so a `STOP` is acknowledged rather than silent. */
export function consentAcknowledgement(keyword: ConsentKeyword): string {
  return keyword === 'opt_out'
    ? 'You will not get any more marketing messages from us. You can still write to us any time, and we will reply.'
    : 'Thank you — you will get our updates again.';
}

/** A note's own rules: something in it, and not an essay. */
export function noteProblem(body: string): string | null {
  const text = body.trim();
  if (text === '') return 'Write something for your colleagues to read.';
  if (text.length > 4000) return 'Up to 4000 characters.';
  return null;
}
