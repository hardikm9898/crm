import { describe, expect, it } from 'vitest';
import { NAV_SECTIONS, visibleSections } from './nav';
import type { CurrentUser } from './session';

function user(permissions: string[]): CurrentUser {
  return {
    user: { id: 'u', email: 'a@b.test', name: 'A B', emailVerified: true, mfaEnabled: false },
    organizations: [],
    activeOrganizationId: 'o',
    permissions,
    scopes: {},
  };
}

describe('visibleSections', () => {
  it('hides an item whose permission the caller does not hold', () => {
    const sections = visibleSections(user([]));
    const labels = sections.flatMap((section) => section.items.map((item) => item.label));
    expect(labels).not.toContain('Roles');
    expect(labels).not.toContain('People');
  });

  it('keeps items that need no permission, so a brand-new member has somewhere to land', () => {
    const labels = visibleSections(user([])).flatMap((section) =>
      section.items.map((item) => item.label),
    );
    expect(labels).toContain('Dashboard');
    expect(labels).toContain('Notifications');
    expect(labels).toContain('Your security');
  });

  it('shows an item as soon as any one of its permissions is held', () => {
    const labels = visibleSections(user(['role:read'])).flatMap((section) =>
      section.items.map((item) => item.label),
    );
    expect(labels).toContain('Roles');
  });

  it('drops a section that ends up empty rather than rendering a bare heading', () => {
    const headings = visibleSections(user([])).map((section) => section.heading);
    expect(headings).not.toContain('Grow');
  });

  it('never invents a permission that is not in the API catalogue shape', () => {
    // A typo here would hide a link forever and look like a permissions bug, so the contract is
    // that every declared permission uses the `resource:action` form the API issues.
    for (const section of NAV_SECTIONS) {
      for (const item of section.items) {
        for (const permission of item.permissions) {
          expect(permission).toMatch(/^[a-z_]+:[a-z_]+$/);
        }
      }
    }
  });
});
