import { describe, expect, it } from 'vitest';
import {
  CONSENT_OPT_IN_WORDS,
  CONSENT_OPT_OUT_WORDS,
  CONVERSATION_LOCK_TTL_MS,
  consentAcknowledgement,
  consentKeyword,
  conversationLock,
  conversationLockExpiry,
  noteProblem,
  snoozeProblem,
} from './conversation-inbox.js';

const NOW = new Date('2026-10-20T09:00:00.000Z');
const ME = '00000000-0000-0000-0000-00000000000a';
const THEM = '00000000-0000-0000-0000-00000000000b';

describe('the soft ownership lock (`FR-WA-7`)', () => {
  it('says nothing when nobody holds it', () => {
    const state = conversationLock({
      lockUserId: null,
      lockExpiresAt: null,
      lockHolderName: null,
      viewerId: ME,
      now: NOW,
    });
    expect(state).toEqual({ held: false, mine: false, expiresAt: null, message: null });
  });

  it('treats an expired lock as absent, so no screen has to compare it to the clock', () => {
    const state = conversationLock({
      lockUserId: THEM,
      lockExpiresAt: new Date(NOW.getTime() - 1),
      lockHolderName: 'Nikhil',
      viewerId: ME,
      now: NOW,
    });
    expect(state.held).toBe(false);
    expect(state.message).toBeNull();
  });

  it('reassures the holder and warns everybody else, from their own side', () => {
    const held = {
      lockUserId: THEM,
      lockExpiresAt: new Date(NOW.getTime() + 60_000),
      lockHolderName: 'Nikhil',
      now: NOW,
    };
    const theirs = conversationLock({ ...held, viewerId: ME });
    expect(theirs.held).toBe(true);
    expect(theirs.mine).toBe(false);
    // Four minutes, because the lock lasts five and one minute of it is left.
    expect(theirs.message).toBe('Nikhil opened this 4 minutes ago — check with them before replying.');

    const mine = conversationLock({ ...held, lockUserId: ME, viewerId: ME });
    expect(mine.mine).toBe(true);
    expect(mine.message).toBe('You have this conversation open.');
  });

  it('counts to one, and says "just now" rather than "0 minutes ago"', () => {
    const fresh = conversationLock({
      lockUserId: THEM,
      lockExpiresAt: new Date(NOW.getTime() + CONVERSATION_LOCK_TTL_MS),
      lockHolderName: 'Nikhil',
      viewerId: ME,
      now: NOW,
    });
    expect(fresh.message).toContain('just now');

    const oneMinute = conversationLock({
      lockUserId: THEM,
      lockExpiresAt: new Date(NOW.getTime() + CONVERSATION_LOCK_TTL_MS - 60_000),
      lockHolderName: 'Nikhil',
      viewerId: ME,
      now: NOW,
    });
    // "1 minutes ago" is the mistake `/today`'s summary already paid for.
    expect(oneMinute.message).toContain('1 minute ago');
  });

  it('names somebody even when the holder has no name to give', () => {
    const state = conversationLock({
      lockUserId: THEM,
      lockExpiresAt: new Date(NOW.getTime() + 60_000),
      lockHolderName: null,
      viewerId: ME,
      now: NOW,
    });
    expect(state.message).toContain('Somebody opened this');
  });

  it('lapses five minutes out', () => {
    expect(conversationLockExpiry(NOW).getTime() - NOW.getTime()).toBe(CONVERSATION_LOCK_TTL_MS);
  });
});

describe('snoozing a conversation', () => {
  it('refuses the past, because a snooze until the past is already broken', () => {
    expect(snoozeProblem(new Date(NOW.getTime() - 1), NOW)).toMatch(/future/);
    expect(snoozeProblem(NOW, NOW)).toMatch(/future/);
  });

  it('refuses a year, because that is really a conversation to close', () => {
    expect(snoozeProblem(new Date(NOW.getTime() + 400 * 86_400_000), NOW)).toMatch(/30 days/);
  });

  it('refuses something that is not a time at all', () => {
    expect(snoozeProblem(new Date('not a date'), NOW)).toBe('That is not a time.');
  });

  it('accepts this afternoon and three weeks out', () => {
    expect(snoozeProblem(new Date(NOW.getTime() + 4 * 3_600_000), NOW)).toBeNull();
    expect(snoozeProblem(new Date(NOW.getTime() + 21 * 86_400_000), NOW)).toBeNull();
  });
});

describe('the words that stop a send (`FR-WA-10`)', () => {
  it('reads a keyword that is the whole message, in any case, with punctuation', () => {
    expect(consentKeyword('STOP')).toBe('opt_out');
    expect(consentKeyword('  stop. ')).toBe('opt_out');
    expect(consentKeyword('Unsubscribe!')).toBe('opt_out');
    expect(consentKeyword('opt out')).toBe('opt_out');
    expect(consentKeyword('START')).toBe('opt_in');
    expect(consentKeyword('unstop')).toBe('opt_in');
  });

  it('ignores a keyword inside a sentence, which is the whole safety of the rule', () => {
    // Silencing somebody for this would be invisible: nothing on any screen says why they stopped
    // getting messages, and the only person who could explain it is the customer.
    expect(consentKeyword('please stop sending me the wrong floor plan')).toBeNull();
    expect(consentKeyword('can you stop by on Saturday?')).toBeNull();
    expect(consentKeyword('I want to unsubscribe from the newsletter you keep sending')).toBeNull();
  });

  it('leaves the ambiguous words alone, deliberately', () => {
    // Each of these is on somebody's published opt-out list, and each is a word a customer uses
    // mid-conversation: "no" answers a question, "cancel" is about an appointment.
    for (const word of ['no', 'cancel', 'end', 'quit', 'yes']) {
      expect(consentKeyword(word), word).toBeNull();
    }
    expect(CONSENT_OPT_OUT_WORDS).not.toContain('no');
    expect(CONSENT_OPT_OUT_WORDS).not.toContain('cancel');
    expect(CONSENT_OPT_IN_WORDS).not.toContain('yes');
  });

  it('says nothing about a message with nothing in it', () => {
    expect(consentKeyword(null)).toBeNull();
    expect(consentKeyword('')).toBeNull();
    expect(consentKeyword('   ')).toBeNull();
    expect(consentKeyword('...')).toBeNull();
  });

  it('acknowledges a stop without promising silence, because a reply still comes', () => {
    const stopped = consentAcknowledgement('opt_out');
    expect(stopped).toContain('marketing');
    // The one thing this sentence must not say is "we will never message you": an answer to a
    // question they ask tomorrow is not marketing, and promising otherwise would be a lie.
    expect(stopped).toContain('we will reply');
    expect(consentAcknowledgement('opt_in')).toMatch(/again/);
  });
});

describe('an internal note', () => {
  it('insists on something to read', () => {
    expect(noteProblem('')).toMatch(/Write something/);
    expect(noteProblem('   \n ')).toMatch(/Write something/);
    expect(noteProblem('Asha wants possession by March')).toBeNull();
  });

  it('has a ceiling the CHECK constraint also has', () => {
    expect(noteProblem('a'.repeat(4000))).toBeNull();
    expect(noteProblem('a'.repeat(4001))).toMatch(/4000/);
  });
});
