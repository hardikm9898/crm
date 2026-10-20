import { dateKeyInZone, nextDateKey, zonedInstant, zonedParts } from './time.js';

/**
 * Notification vocabulary, and the one piece of arithmetic quiet hours needs (`FR-NOT-1..3`).
 *
 * Here rather than in the API because three consumers must agree: the service that decides whether
 * to write a notification at all, the sweep that releases the ones it held, and the preferences
 * screen that has to offer exactly the types the product actually sends. A type the screen offers
 * and nothing emits is a switch that does nothing; a type something emits and the screen omits is a
 * notification nobody can turn off.
 */

// ── Channels ────────────────────────────────────────────────────────────────

/** Every channel the design names (`FR-NOT-1`, `docs/database-design.md` §13). */
export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'whatsapp', 'push'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * The channels this release can actually deliver on.
 *
 * A preferences screen offering a tick box for a channel that silently drops every message is
 * worse than one that says the channel is not here yet — somebody would turn the in-app
 * notification off in favour of an email that never arrives.
 *
 * `email` joined the list in Phase 3 step 7, when there was a sender behind it: a port with a real
 * provider driver, a suppression list checked before every send, and a webhook that fills it. Until
 * then the screen rendered that half greyed out and said so. `whatsapp` and `push` still do.
 */
export const DELIVERABLE_CHANNELS: readonly NotificationChannel[] = ['in_app', 'email'];

export function isDeliverableChannel(value: string): value is NotificationChannel {
  return (DELIVERABLE_CHANNELS as readonly string[]).includes(value);
}

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Whether a notification held through the night is still worth delivering in the morning.
 *
 * The question the deferral makes unavoidable: a follow-up that went overdue at 21:00 and was done
 * at 08:30 must not arrive at 09:00 as "overdue". Resolved by the API, which has the database —
 * this is only the name of the question, so that nothing about Prisma reaches this package.
 */
export const STALENESS_CHECKS = [
  'never',
  'task_still_open',
  'clock_still_running',
  'call_still_open',
  /**
   * Whether the connection this notice is about is still in a state a person has to fix.
   *
   * A credential refused at 21:40 and reconnected at 22:10 must not produce a 09:00 notice saying
   * it was refused — that reads as the product being a day behind, which is worse than never
   * having held the message.
   */
  'connection_still_broken',
] as const;
export type StalenessCheck = (typeof STALENESS_CHECKS)[number];

export interface NotificationTypeSpec {
  readonly type: string;
  /** What the preferences screen calls it. */
  readonly label: string;
  /** The sentence under it, which is what makes a preference screen usable rather than a list. */
  readonly hint: string;
  readonly group: 'work' | 'leads' | 'workspace';
  readonly defaultChannels: readonly NotificationChannel[];
  /**
   * `false` for the system notices `FR-NOT-3` says are not opt-out. The API refuses to switch one
   * off, and the screen shows it as always on, with the reason.
   */
  readonly optOut: boolean;
  /**
   * `false` for a notice that must reach somebody whatever the hour. Nothing qualifies today —
   * every notification this product sends is about work that can wait until the morning, and a
   * product that wakes somebody up to tell them a follow-up is late has misunderstood the problem.
   */
  readonly respectsQuietHours: boolean;
  readonly staleness: StalenessCheck;
}

/**
 * Every type this product actually sends.
 *
 * `FR-NOT-2` lists thirteen; eight exist, because the channels and the modules behind the others
 * have not been built. Listing all thirteen would give the screen five switches that control
 * nothing — the kind of half-truth that makes somebody stop believing the rest of the screen.
 * `webhook.disabled` is not one of `FR-NOT-2`'s thirteen and is here anyway: `FR-API-4` asks for a
 * failure alert, and an integration that has silently stopped is exactly what a notification is
 * for.
 */
export const NOTIFICATION_TYPES: readonly NotificationTypeSpec[] = [
  {
    type: 'task.reminder',
    label: 'Follow-up reminders',
    hint: 'Before a call or meeting you planned, at the offsets you chose on it.',
    group: 'work',
    defaultChannels: ['in_app'],
    optOut: true,
    respectsQuietHours: true,
    // A reminder for a follow-up somebody has already finished is noise.
    staleness: 'task_still_open',
  },
  {
    type: 'task.overdue',
    label: 'Overdue follow-ups',
    hint: 'When a follow-up passes its time — to you, and to whoever manages your queue.',
    group: 'work',
    defaultChannels: ['in_app'],
    optOut: true,
    respectsQuietHours: true,
    staleness: 'task_still_open',
  },
  {
    type: 'call.outcome_missing',
    label: 'Calls with no outcome recorded',
    hint: 'When you dialled somebody from the product and never said what happened.',
    group: 'work',
    defaultChannels: ['in_app'],
    optOut: true,
    respectsQuietHours: true,
    /**
     * The nudge exists because the manual telephony driver cannot know how a call went: it hands
     * the number to a phone, and the `dialing` row it leaves is honest but useless until somebody
     * says what happened. Without this, a workspace's call log quietly fills with attempts and
     * "what happened on those forty calls" stays unanswerable — which is the whole thing the
     * feature was built to answer.
     *
     * Stale the moment the outcome is recorded, which is the common case: somebody rings at 21:40,
     * logs it at 21:45, and must not be told at 07:00 to do what they already did.
     */
    staleness: 'call_still_open',
  },
  {
    type: 'sla.at_risk',
    label: 'Response times running out',
    hint: 'When a promise your workspace made is close to being missed.',
    group: 'work',
    defaultChannels: ['in_app'],
    optOut: true,
    respectsQuietHours: true,
    // Warning somebody that a clock is "running out" after it has been answered is absurd.
    staleness: 'clock_still_running',
  },
  {
    type: 'sla.breached',
    label: 'Response times missed',
    hint: 'When a promise was missed. The record of it stays either way.',
    group: 'work',
    defaultChannels: ['in_app'],
    optOut: true,
    respectsQuietHours: true,
    /**
     * `never`: a missed promise is a fact about the past, and the morning after is exactly when
     * somebody should be told. The clock being answered at 08:00 does not unmake the breach —
     * unlike the warning above, which was about a deadline that has since stopped mattering.
     */
    staleness: 'never',
  },
  {
    type: 'lead.unassigned_pool',
    label: 'Leads nobody has been given',
    hint: 'When a captured lead lands in the pool without an owner.',
    group: 'leads',
    defaultChannels: ['in_app'],
    optOut: true,
    respectsQuietHours: true,
    staleness: 'never',
  },
  {
    type: 'member.joined',
    label: 'People joining the workspace',
    hint: 'When somebody accepts an invitation.',
    group: 'workspace',
    defaultChannels: ['in_app'],
    optOut: true,
    respectsQuietHours: true,
    staleness: 'never',
  },
  {
    type: 'webhook.disabled',
    label: 'An integration we stopped sending to',
    hint: 'When an endpoint fails fifteen times in a row, or tells us to stop. These cannot be turned off.',
    group: 'workspace',
    defaultChannels: ['in_app'],
    /**
     * Not opt-out, for the same reason as the trial notice below: an auto-disabled endpoint means
     * the workspace's integration has stopped receiving **everything**, silently, and the one
     * message that explains it must not be suppressible by the person who would have to fix it.
     */
    optOut: false,
    respectsQuietHours: true,
    // A fact about the past: the endpoint was disabled, and it is still disabled in the morning.
    staleness: 'never',
  },
  {
    type: 'integration.revoked',
    label: 'A connected provider that refused us',
    hint: 'When a provider rejects the credential you connected — the email or the leads it carries have stopped. These cannot be turned off.',
    group: 'workspace',
    defaultChannels: ['in_app'],
    /**
     * Not opt-out, for the same reason as the disabled endpoint above: a refused credential means
     * something the workspace depends on has stopped, silently, and the one message that explains
     * it must not be suppressible by the person who would have to reconnect it.
     */
    optOut: false,
    respectsQuietHours: true,
    /**
     * Unlike the disabled endpoint, this one **can** stop mattering while it is held: somebody
     * pastes a fresh token at 22:00 and the probe goes green. A warning delivered at 09:00 about a
     * credential that already works is exactly the staleness the release sweep exists to catch.
     */
    staleness: 'connection_still_broken',
  },
  {
    type: 'trial.expired',
    label: 'Billing and subscription',
    hint: 'When the trial ends or the subscription lapses. These cannot be turned off.',
    group: 'workspace',
    defaultChannels: ['in_app'],
    /**
     * The system notice `FR-NOT-3` exempts. Every write in the product is refused once a trial
     * expires; somebody who had switched this off would experience that as the product breaking,
     * with the one message that explains it suppressed by their own setting.
     */
    optOut: false,
    respectsQuietHours: true,
    staleness: 'never',
  },
  {
    type: 'whatsapp.send_failed',
    label: 'A WhatsApp message that did not send',
    hint: 'When WhatsApp refuses a reply you sent — with its reason, so you can decide what to do.',
    group: 'work',
    defaultChannels: ['in_app'],
    optOut: true,
    /**
     * **Not** held for quiet hours, unlike every other work notification. `FR-WA-9` asks for a
     * failure that is never silent, and the cost of holding this one is paid by the customer rather
     * than by us: a reply that did not send at 23:00 and is not noticed until 07:00 is eight hours
     * of somebody waiting for an answer they will never get. The agent chose to send at that hour;
     * the failure is part of what they chose.
     */
    respectsQuietHours: false,
    /**
     * No staleness kind, deliberately. A send that failed still failed after a retry succeeds — the
     * customer got the message late, and "was I ever told?" has to stay answerable. The registry's
     * own rule is that a type with no entry is never stale, which is the right answer here rather
     * than an omission.
     */
    staleness: 'never',
  },
  {
    type: 'conversation.assigned',
    label: 'A conversation handed to you',
    hint: 'When somebody assigns or transfers a WhatsApp conversation to you, with their reason.',
    group: 'work',
    defaultChannels: ['in_app'],
    optOut: true,
    respectsQuietHours: true,
    /**
     * Never stale. A conversation somebody handed you at 21:40 is still yours at 09:00 — even if
     * they took it back in between, "I was given this and then it moved" is a thing worth knowing,
     * and holding the first half while dropping it would tell you only about the second.
     */
    staleness: 'never',
  },
  {
    type: 'conversation.mentioned',
    label: 'Mentions in conversation notes',
    hint: 'When a colleague names you in an internal note on a conversation.',
    group: 'work',
    defaultChannels: ['in_app'],
    optOut: true,
    respectsQuietHours: true,
    // A mention is somebody asking you a question. It does not stop mattering because time passed.
    staleness: 'never',
  },
  {
    type: 'conversation.woke',
    label: 'Snoozed conversations coming back',
    hint: 'When a conversation you put aside reaches the time you chose.',
    group: 'work',
    defaultChannels: ['in_app'],
    optOut: true,
    /**
     * Held through quiet hours, unlike the WhatsApp send failure. This one is a reminder somebody
     * set **for themselves**, so the cost of holding it is paid by the person who chose the time —
     * which is the whole test the registry applies.
     */
    respectsQuietHours: true,
    staleness: 'never',
  },
];

export function notificationType(type: string): NotificationTypeSpec | undefined {
  return NOTIFICATION_TYPES.find((spec) => spec.type === type);
}

/**
 * The channels a type goes out on, given what the person chose.
 *
 * `undefined` means no preference row exists, which is the common case and means "the default" —
 * so a new notification type reaches everybody without backfilling a row per person. An empty
 * array is a real answer: "do not tell me". A type that is not opt-out ignores both.
 */
export function channelsFor(
  type: string,
  chosen: readonly string[] | undefined,
): readonly NotificationChannel[] {
  const spec = notificationType(type);
  // An unknown type is delivered in-app rather than dropped: a producer added without a registry
  // entry should be visible and annoying, not silent. The registry test is what catches it.
  if (!spec) return ['in_app'];
  if (!spec.optOut) return spec.defaultChannels;
  if (chosen === undefined) return spec.defaultChannels;
  return chosen.filter(isDeliverableChannel);
}

// ── Quiet hours ─────────────────────────────────────────────────────────────

/**
 * A person's quiet window, as a pair of wall-clock minutes on their local day.
 *
 * Minutes on a local day rather than two instants, for the reason the working-hours calendar is
 * stored that way: "21:00 to 07:00" has to survive a clock change, and an instant does not.
 */
export interface QuietHours {
  readonly startMinute: number;
  readonly endMinute: number;
  readonly timeZone: string;
}

export const MINUTES_IN_DAY = 24 * 60;

/** Whether a quiet window spans midnight, which most of them do. */
export function crossesMidnight(quiet: QuietHours): boolean {
  return quiet.endMinute <= quiet.startMinute;
}

export function isQuiet(at: Date, quiet: QuietHours): boolean {
  if (quiet.startMinute === quiet.endMinute) return false;
  const { hour, minute } = zonedParts(at, quiet.timeZone);
  const minuteOfDay = hour * 60 + minute;
  return crossesMidnight(quiet)
    ? minuteOfDay >= quiet.startMinute || minuteOfDay < quiet.endMinute
    : minuteOfDay >= quiet.startMinute && minuteOfDay < quiet.endMinute;
}

/**
 * The instant a notification arriving `at` must be held until — or `null` if it may go out now.
 *
 * **The end of the quiet window in the person's own zone, not `at + n hours`.** A window that
 * closes at 07:00 closes at 07:00 whatever the clocks did overnight; adding a duration would
 * deliver at 06:00 on the spring-forward morning and at 08:00 on the autumn one, and the second
 * one is a notification an hour late on the day somebody has an extra hour to read it.
 *
 * A zero-length window (start equal to end) is "never quiet" rather than "always quiet". The
 * database refuses to store one — the ambiguity is resolved there, and this is the defensive half.
 */
export function quietHoursHold(at: Date, quiet: QuietHours): Date | null {
  if (!isQuiet(at, quiet)) return null;
  const { hour, minute } = zonedParts(at, quiet.timeZone);
  const minuteOfDay = hour * 60 + minute;
  const today = dateKeyInZone(at, quiet.timeZone);
  // Inside a window that began yesterday evening, the end is still today's; inside one that began
  // today, it is tomorrow's.
  const endsToday = !crossesMidnight(quiet) || minuteOfDay < quiet.endMinute;
  const key = endsToday ? today : nextDateKey(today);
  const release = zonedInstant(key, quiet.endMinute, quiet.timeZone);
  /* c8 ignore next */
  if (release.getTime() <= at.getTime()) return null;
  return release;
}

/** Whether a stored minute-of-day is one this product will accept. */
export function isMinuteOfDay(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < MINUTES_IN_DAY;
}

/** `21:30`, for a screen or a sentence. */
export function formatMinuteOfDay(minuteOfDay: number): string {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** `21:30` back to a minute of the day, or `null` for anything that is not one. */
export function parseMinuteOfDay(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}
