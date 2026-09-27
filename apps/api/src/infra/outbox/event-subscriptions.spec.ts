import { describe, expect, it } from 'vitest';
import { EVENT_SUBSCRIPTIONS, isKnownEvent, subscribersFor } from './event-subscriptions.js';
import { QUEUE_NAMES } from '../queue/queue.constants.js';

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

  it('declares no duplicate job for one event', () => {
    for (const [eventName, subscriptions] of Object.entries(EVENT_SUBSCRIPTIONS)) {
      const keys = subscriptions.map((s) => `${s.queue}/${s.jobName}`);
      expect(new Set(keys).size, eventName).toBe(keys.length);
    }
  });
});
