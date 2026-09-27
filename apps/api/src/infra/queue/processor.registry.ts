import type { Type } from '@nestjs/common';
import {
  EmailVerificationMailProcessor,
  PasswordResetMailProcessor,
  SecurityNoticeMailProcessor,
} from '../../modules/auth/processors/credential-mail.processor.js';
import { InvitationMailProcessor } from '../../modules/users/processors/invitation-mail.processor.js';
import {
  InvitationExpiryProcessor,
  OutboxReapProcessor,
  SessionPruneProcessor,
  TrialCheckProcessor,
} from '../../modules/maintenance/maintenance.processors.js';
import {
  MemberJoinedNotificationProcessor,
  TrialExpiredNotificationProcessor,
} from '../../modules/notifications/notifications.processor.js';
import type { JobProcessor } from './job-processor.js';

/**
 * Every background processor in the application, in one readable list.
 *
 * Deliberately a list of classes resolved by the bootstrap rather than a DI multi-provider: the
 * processors live in domain modules, and those modules depend on the queue infrastructure. A
 * token injected into `WorkerService` would invert that and create a cycle — and, when
 * `QueueModule` is global, a module-local default silently shadows the root module's override,
 * which is exactly the bug that produced a worker consuming nothing.
 *
 * A processor missing from this list is caught by the integration suite, which asserts that every
 * subscribed event and every schedule has a processor registered.
 */
export const PROCESSOR_TYPES: readonly Type<JobProcessor>[] = [
  // notifications
  InvitationMailProcessor,
  EmailVerificationMailProcessor,
  PasswordResetMailProcessor,
  SecurityNoticeMailProcessor,
  MemberJoinedNotificationProcessor,
  TrialExpiredNotificationProcessor,
  // maintenance
  SessionPruneProcessor,
  InvitationExpiryProcessor,
  TrialCheckProcessor,
  OutboxReapProcessor,
];

/** Resolves the processors from a Nest context (application or test). */
export function resolveProcessors(context: { get<T>(type: Type<T>): T }): JobProcessor[] {
  return PROCESSOR_TYPES.map((type) => context.get(type));
}
