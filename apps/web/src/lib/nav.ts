import type { CurrentUser } from './session';

/**
 * The navigation model.
 *
 * Navigation is filtered by the permissions the API reported, so nobody is shown a link that leads
 * to a 403. This is presentation only — hiding a link is not authorization, and every one of these
 * routes is independently guarded server-side (docs/frontend-architecture.md §1).
 *
 * Sections whose modules arrive in later phases are listed with `phase`, and render as disabled
 * "coming in phase N" rows rather than being silently absent: a business owner evaluating the
 * product should be able to see where things will be.
 */
export interface NavItem {
  readonly label: string;
  readonly href: string;
  /** Any one of these is enough to see the item. Empty means "always visible". */
  readonly permissions: readonly string[];
  /** Set when the destination is not built yet. */
  readonly phase?: number;
}

export interface NavSection {
  readonly heading: string;
  readonly items: readonly NavItem[];
}

export const NAV_SECTIONS: readonly NavSection[] = [
  {
    heading: 'Work',
    items: [
      { label: 'Dashboard', href: '/dashboard', permissions: [] },
      { label: 'Leads', href: '/leads', permissions: ['lead:read'] },
      { label: 'Pipeline', href: '/pipeline', permissions: ['lead:read'] },
      { label: 'Customers', href: '/customers', permissions: ['customer:read'] },
      { label: 'Deals', href: '/deals', permissions: ['deal:read'] },
      { label: 'Quotations', href: '/quotations', permissions: ['deal:read'] },
      { label: 'Payments', href: '/payments', permissions: ['payment:read'] },
      { label: 'Follow-ups', href: '/tasks', permissions: ['task:read'] },
      { label: 'Response times', href: '/sla', permissions: ['sla:read'] },
      { label: 'Inbox', href: '/inbox', permissions: ['conversation:read'], phase: 5 },
    ],
  },
  {
    heading: 'Grow',
    items: [
      { label: 'Campaigns', href: '/campaigns', permissions: ['marketing:read'], phase: 9 },
      { label: 'Website', href: '/website', permissions: ['settings:manage'], phase: 7 },
      { label: 'Reports', href: '/reports', permissions: ['report:read'], phase: 2 },
    ],
  },
  {
    heading: 'Workspace',
    items: [
      { label: 'Notifications', href: '/notifications', permissions: [] },
      // Exports are a workspace thing rather than a lead thing: the files outlive the list they
      // came from, and the person who comes looking for yesterday's download is not on the lead
      // screen. Import stays on the lead list, where somebody with a spreadsheet already is.
      { label: 'Exports', href: '/leads/exports', permissions: ['export:data'] },
      { label: 'Organization', href: '/settings', permissions: ['organization:read'] },
      { label: 'People', href: '/settings/members', permissions: ['user:read'] },
      { label: 'Roles', href: '/settings/roles', permissions: ['role:read'] },
      // A price list is workspace configuration, like statuses and sources — not a deal screen.
      { label: 'Products', href: '/settings/products', permissions: ['deal:read'] },
      // Numbering sits beside the price list for the same reason: moving the counter affects every
      // quotation that follows, which is not a thing to do from a quotation screen.
      {
        label: 'Quotation numbering',
        href: '/settings/quotations',
        permissions: ['settings:manage'],
      },
      {
        label: 'Payment methods',
        href: '/settings/payment-methods',
        permissions: ['settings:manage'],
      },
      // The follow-up vocabulary sits with the price list and the numbering for the same reason:
      // renaming an outcome changes what every past completion reads as, which is not a thing to
      // do from a follow-up screen.
      {
        label: 'Follow-up settings',
        href: '/settings/follow-ups',
        permissions: ['settings:manage'],
      },
      {
        label: 'Response promises',
        href: '/settings/sla',
        permissions: ['settings:manage'],
      },
      { label: 'Your security', href: '/settings/security', permissions: [] },
    ],
  },
];

export function visibleSections(user: CurrentUser): NavSection[] {
  return NAV_SECTIONS.map((section) => ({
    heading: section.heading,
    items: section.items.filter(
      (item) =>
        item.permissions.length === 0 ||
        item.permissions.some((permission) => user.permissions.includes(permission)),
    ),
  })).filter((section) => section.items.length > 0);
}
