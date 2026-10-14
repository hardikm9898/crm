import { describe, expect, it } from 'vitest';
import {
  EMAIL_EVENTS,
  EMAIL_KINDS,
  EMAIL_STATUSES,
  ESSENTIAL_EMAIL_KINDS,
  SETTLED_EMAIL_STATUSES,
  SUPPRESSION_REASONS,
  isEssentialEmailKind,
  looksLikeEmailAddress,
  normaliseEmailAddress,
  statusForEmailEvent,
  suppressionBlocks,
  suppressionFor,
  suppressionStops,
} from './email.js';

describe('how much a suppression stops', () => {
  it('stops everything when the mailbox is gone', () => {
    // There is no message important enough to be worth sending to an address that cannot receive
    // it: the send fails *and* the sending domain pays for it.
    for (const reason of ['bounce', 'invalid']) {
      expect(suppressionBlocks(reason), reason).toBe('all');
      for (const kind of EMAIL_KINDS) {
        expect(suppressionStops(reason, kind), `${reason}/${kind}`).toBe(true);
      }
    }
  });

  it('still lets somebody reset their own password after they complained', () => {
    // A complaint is a request to stop being *contacted*. Treating it as consent to be locked out
    // of your own account is the kind of literal-mindedness that loses a customer who was only
    // annoyed.
    for (const reason of ['complaint', 'manual']) {
      expect(suppressionBlocks(reason), reason).toBe('non_essential');
      expect(suppressionStops(reason, 'password_reset'), reason).toBe(false);
      expect(suppressionStops(reason, 'email_verification'), reason).toBe(false);
      expect(suppressionStops(reason, 'security_notice'), reason).toBe(false);
      expect(suppressionStops(reason, 'notification'), reason).toBe(true);
      expect(suppressionStops(reason, 'invitation'), reason).toBe(true);
    }
  });

  it('has an answer for every reason the database allows', () => {
    for (const reason of SUPPRESSION_REASONS) {
      expect(['all', 'non_essential'], reason).toContain(suppressionBlocks(reason));
    }
  });

  it('treats an unknown reason as the gentler of the two, not the harsher', () => {
    // A reason this build has never heard of should not silently stop a password reset. The same
    // default the timeline and notification registries take: a thing nobody classified should be
    // noticed, not disappear.
    expect(suppressionBlocks('whatever')).toBe('non_essential');
    expect(suppressionStops('whatever', 'password_reset')).toBe(false);
  });
});

describe('which kinds are a person’s own business', () => {
  it('is the three about their account, and nothing else', () => {
    expect([...ESSENTIAL_EMAIL_KINDS]).toEqual([
      'email_verification',
      'password_reset',
      'security_notice',
    ]);
    // An invitation is somebody else contacting them, so a complaint covers it.
    expect(isEssentialEmailKind('invitation')).toBe(false);
    expect(isEssentialEmailKind('notification')).toBe(false);
  });

  it('names only kinds that exist', () => {
    for (const kind of ESSENTIAL_EMAIL_KINDS) {
      expect(EMAIL_KINDS, kind).toContain(kind);
    }
  });
});

describe('normalising an address', () => {
  it('lower-cases and trims', () => {
    expect(normaliseEmailAddress('  Priya@Example.COM ')).toBe('priya@example.com');
  });

  it('does not canonicalise further, because that would over-match', () => {
    // Stripping dots or a `+tag` is a trick that works at exactly one provider. Everywhere else
    // these are different mailboxes, and a suppression list that over-matches silently stops mail
    // somebody is waiting for.
    expect(normaliseEmailAddress('a.b+news@gmail.com')).toBe('a.b+news@gmail.com');
  });
});

describe('the shape check', () => {
  it('accepts an ordinary address', () => {
    expect(looksLikeEmailAddress('priya@example.com')).toBe(true);
    expect(looksLikeEmailAddress('a.b+news@mail.example.co.in')).toBe(true);
  });

  it('refuses what a provider would refuse for us', () => {
    for (const bad of ['', 'priya', 'priya@', '@example.com', 'priya@example', 'a b@c.com']) {
      expect(looksLikeEmailAddress(bad), bad).toBe(false);
    }
  });

  it('refuses an address longer than any mailbox', () => {
    expect(looksLikeEmailAddress(`${'a'.repeat(320)}@example.com`)).toBe(false);
  });
});

describe('a delivery event', () => {
  it('maps to a status that exists', () => {
    for (const event of EMAIL_EVENTS) {
      expect(EMAIL_STATUSES, event).toContain(statusForEmailEvent(event));
      expect(SETTLED_EMAIL_STATUSES, event).toContain(statusForEmailEvent(event));
    }
  });

  it('suppresses a hard bounce and a complaint, and nothing else', () => {
    expect(suppressionFor('bounced')).toBe('bounce');
    expect(suppressionFor('complained')).toBe('complaint');
    // A full mailbox or a greylisting is a reason to try again, not a reason to stop writing to
    // somebody for ever.
    expect(suppressionFor('failed')).toBeNull();
    expect(suppressionFor('delivered')).toBeNull();
  });

  it('only ever suppresses for a reason the database allows', () => {
    for (const event of EMAIL_EVENTS) {
      const reason = suppressionFor(event);
      if (reason !== null) expect(SUPPRESSION_REASONS, event).toContain(reason);
    }
  });
});

describe('the status vocabulary', () => {
  it('counts a refusal as an outcome, not an error', () => {
    // `suppressed` is the answer to "why did this never arrive", which is the reason the delivery
    // log exists at all.
    expect(EMAIL_STATUSES).toContain('suppressed');
    expect(SETTLED_EMAIL_STATUSES).toContain('suppressed');
  });

  it('leaves the two live statuses out of the settled set', () => {
    expect(SETTLED_EMAIL_STATUSES).not.toContain('queued');
    expect(SETTLED_EMAIL_STATUSES).not.toContain('sent');
    expect([...SETTLED_EMAIL_STATUSES].sort()).toEqual(
      EMAIL_STATUSES.filter((s) => s !== 'queued' && s !== 'sent').sort(),
    );
  });
});
