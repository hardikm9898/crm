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
      // First, because it is where an executive lands and the first thing they look for. The
      // dashboard is the manager's screen and sits under it.
      { label: 'Today', href: '/today', permissions: ['task:read'] },
      { label: 'Dashboard', href: '/dashboard', permissions: [] },
      { label: 'Leads', href: '/leads', permissions: ['lead:read'] },
      { label: 'Pipeline', href: '/pipeline', permissions: ['lead:read'] },
      { label: 'Customers', href: '/customers', permissions: ['customer:read'] },
      { label: 'Deals', href: '/deals', permissions: ['deal:read'] },
      { label: 'Quotations', href: '/quotations', permissions: ['deal:read'] },
      { label: 'Payments', href: '/payments', permissions: ['payment:read'] },
      { label: 'Follow-ups', href: '/tasks', permissions: ['task:read'] },
      // The call log sits beside the follow-ups it finishes: both answer "what has actually been
      // done about these leads", and the calls awaiting an outcome are work, not history.
      { label: 'Calls', href: '/calls', permissions: ['call:read'] },
      { label: 'Response times', href: '/sla', permissions: ['sla:read'] },
      // The manager's screen. `report:read` is the honest gate: it is about other people's work.
      { label: 'Oversight', href: '/oversight', permissions: ['report:read'] },
      // Built as of Phase 5 step 1: the conversations a WhatsApp number receives, beside the lead
      // each one belongs to. The `phase` marker is gone because the screen is real — a disabled
      // "coming in phase 5" row on a screen that exists is the navigation lying.
      { label: 'Inbox', href: '/inbox', permissions: ['conversation:read'] },
    ],
  },
  {
    heading: 'Grow',
    items: [
      // Capture forms sit at the top of Grow rather than in Workspace settings: a form is a
      // marketing object with a lead-capture consequence, and the person who builds the campaign
      // builds the form it points at.
      { label: 'Forms', href: '/forms', permissions: ['form:read'] },
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
        label: 'Call outcomes',
        href: '/settings/calls',
        permissions: ['settings:manage'],
      },
      {
        label: 'Response promises',
        href: '/settings/sla',
        permissions: ['settings:manage'],
      },
      // The lead API's two screens sit beside each other, and in Workspace rather than Grow: a key
      // is a credential, and the log behind it is read by whoever built the integration — not by
      // the person running the campaign the leads came from.
      {
        // No longer only the lead API's: step 4 made a key a credential for the whole REST
        // surface, so the label says what it is rather than what it was first used for.
        label: 'API keys',
        href: '/settings/api-keys',
        permissions: ['api_key:manage'],
      },
      {
        label: 'API activity',
        href: '/settings/api-activity',
        permissions: ['api_key:manage'],
      },
      {
        label: 'Integration log',
        href: '/ingestion',
        permissions: ['api_key:manage'],
      },
      // The other direction of the same contract, beside it: somebody wiring up an integration
      // reads both screens in one sitting.
      {
        label: 'Outbound webhooks',
        href: '/settings/webhooks',
        permissions: ['webhook:manage'],
      },
      // The providers this workspace holds a credential for. Beside the two surfaces it uses:
      // somebody connecting Postmark and somebody wiring up a partner's webhook are the same
      // person on the same afternoon.
      {
        label: 'Integrations',
        href: '/settings/integrations',
        permissions: ['integration:manage'],
      },
      // Under Integrations, because that is where its credential is: this screen is the numbers
      // and who answers them, which is the WhatsApp-shaped half of the same setup.
      {
        label: 'WhatsApp',
        href: '/settings/whatsapp',
        permissions: ['whatsapp:manage'],
      },
      // Beside the numbers, because the two are one setup: a template is the only thing that can
      // reach somebody outside the 24-hour window, and the number is what sends it.
      {
        label: 'WhatsApp templates',
        href: '/settings/whatsapp/templates',
        permissions: ['whatsapp:manage'],
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
