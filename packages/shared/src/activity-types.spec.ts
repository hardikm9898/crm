import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_MODULES,
  ACTIVITY_TYPES,
  activityModule,
  isKnownActivityType,
} from './activity-types.js';

describe('the activity type registry', () => {
  it('uses `module.event` shape throughout, which is what the module derivation relies on', () => {
    for (const type of Object.values(ACTIVITY_TYPES)) {
      expect(type, `${type} is not module.event`).toMatch(/^[a-z]+\.[a-z_]+$/);
    }
  });

  it('has no duplicate values — two constants for one string would double-render a timeline', () => {
    const values = Object.values(ACTIVITY_TYPES);
    expect(new Set(values).size).toBe(values.length);
  });

  it('recognises a known type and rejects an invented one', () => {
    expect(isKnownActivityType('lead.created')).toBe(true);
    expect(isKnownActivityType('lead.invented')).toBe(false);
  });

  it('derives the module from the prefix rather than a second list that could disagree', () => {
    expect(activityModule('whatsapp.template_sent')).toBe('whatsapp');
    expect(ACTIVITY_MODULES).toContain('lead');
    expect(ACTIVITY_MODULES).toContain('automation');
  });

  it('covers every event type the Phase 2 timeline must show', () => {
    // Named explicitly: the exit criterion is that a lead's whole journey is readable, and a missing
    // constant here is a silent gap rather than a failure.
    for (const required of [
      'lead.created',
      'lead.source_captured',
      'lead.assigned',
      'lead.status_changed',
      'lead.stage_changed',
      'lead.field_updated',
      'lead.converted',
      'lead.lost',
    ]) {
      expect(isKnownActivityType(required), `${required} is missing`).toBe(true);
    }
  });
});
