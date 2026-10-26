import { describe, expect, it } from 'vitest';
import { EVENT_SUBSCRIPTIONS, isKnownEvent, subscribersFor } from './event-subscriptions.js';
import { JOBS, QUEUE_NAMES, QUEUES } from '../queue/queue.constants.js';
import { WEBHOOK_EVENT_TYPES, WORKFLOW_TRIGGERS } from '@leados/shared';

describe('event subscriptions', () => {
  it('routes each subscribed event to a declared queue', () => {
    for (const [eventName, subscriptions] of Object.entries(EVENT_SUBSCRIPTIONS)) {
      for (const subscription of subscriptions) {
        expect(QUEUE_NAMES, `${eventName} → ${subscription.queue}`).toContain(subscription.queue);
      }
    }
  });

  it('treats an unsubscribed event as a no-op, not an error', () => {
    // An event with no listeners is still recorded and marked published; that is what lets a
    // producer emit before any consumer exists.
    expect(subscribersFor('organization.created')).toEqual([]);
    expect(subscribersFor('something.nobody.listens.to')).toEqual([]);
  });

  it('distinguishes a known event with no subscribers from an unknown one', () => {
    // The distinction is what turns a typo in an event name into something noticeable.
    expect(isKnownEvent('organization.created')).toBe(true);
    expect(isKnownEvent('organisation.created')).toBe(false);
  });

  it('routes the credential and invitation emails that exist today', () => {
    expect(subscribersFor('invitation.sent')).toHaveLength(1);
    expect(subscribersFor('user.registered')[0]?.jobName).toBe('mail.email-verification');
    expect(subscribersFor('user.password_reset_requested')[0]?.jobName).toBe('mail.password-reset');
  });

  it('fans out every event an endpoint can subscribe to', () => {
    // The whole failure this test exists for: a type added to `WEBHOOK_EVENT_TYPES` and offered on
    // the settings screen, with nothing wired here — an endpoint that looks subscribed, and
    // receives nothing, for as long as nobody checks.
    for (const type of WEBHOOK_EVENT_TYPES) {
      const subscribers = subscribersFor(type);
      expect(
        subscribers.some(
          (entry) => entry.queue === QUEUES.WEBHOOKS && entry.jobName === JOBS.WEBHOOK_FANOUT,
        ),
        `${type} has no webhook fan-out`,
      ).toBe(true);
    }
  });

  it('fans out only events the product actually emits', () => {
    // The other direction: a fan-out on an event nothing emits is a subscription nobody can ever
    // receive, which is the same half-truth seen from the endpoint's side.
    const fannedOut = Object.entries(EVENT_SUBSCRIPTIONS)
      .filter(([, subscriptions]) =>
        subscriptions.some((entry) => entry.jobName === JOBS.WEBHOOK_FANOUT),
      )
      .map(([name]) => name);
    expect([...fannedOut].sort()).toEqual([...WEBHOOK_EVENT_TYPES].sort());
  });

  it('knows every event the product emits, even the ones nothing listens to', () => {
    // `isKnownEvent` is what turns a typo into something noticeable, and it can only do that if the
    // registry is complete — six events emitted since Phase 2 were missing from it.
    for (const name of [
      'customer.created',
      'deal.won',
      'quotation.sent',
      'payment.received',
      'lead.converted',
      'onboarding.industry_template_applied',
    ]) {
      expect(isKnownEvent(name), name).toBe(true);
    }
  });

  /**
   * Phase 6, step 1. A trigger the automation editor offers with no event behind it is a workflow
   * that can never run and looks built — the same failure `WEBHOOK_EVENT_TYPES` is checked for
   * two cases above, one layer along. `whatsapp.message_received` was found by exactly this
   * assertion: the registry offered "a customer replies" and nothing emitted it.
   */
  it('knows every event an automation trigger listens to', () => {
    for (const trigger of WORKFLOW_TRIGGERS) {
      if (trigger.event === null) continue;
      expect(isKnownEvent(trigger.event), `${trigger.key} → ${trigger.event}`).toBe(true);
    }
  });

  /**
   * Phase 6, step 2. Knowing the event is not enough: it has to reach the **dispatcher**. A
   * trigger whose event is listed with no automation subscription is a workflow that publishes,
   * reports itself live, and never runs — which is the same failure one layer along from the one
   * above, and the reason `AUTOMATION` is written once and spread.
   */
  it('sends every automation trigger’s event to the dispatcher', () => {
    for (const trigger of WORKFLOW_TRIGGERS) {
      if (trigger.event === null) continue;
      const subscribed = subscribersFor(trigger.event).some(
        (subscription) => subscription.jobName === JOBS.AUTOMATION_TRIGGER,
      );
      expect(subscribed, `${trigger.key} → ${trigger.event} reaches no dispatcher`).toBe(true);
    }
  });

  it('declares no duplicate job for one event', () => {
    for (const [eventName, subscriptions] of Object.entries(EVENT_SUBSCRIPTIONS)) {
      const keys = subscriptions.map((s) => `${s.queue}/${s.jobName}`);
      expect(new Set(keys).size, eventName).toBe(keys.length);
    }
  });
});
