/**
 * `/my/today` takes no parameters, and that is the design.
 *
 * Every other list in the product is filterable, because every other list is a question somebody
 * asks. Today is not a question — it is *the* answer, for the person holding the phone, and a
 * screen whose contents depend on a query string is a screen two people describe differently when
 * one of them is trying to help the other over a call. A manager who wants somebody else's queue
 * has `/tasks?assignedUserId=` and `/sla/board`, both of which already data-scope properly.
 *
 * It also keeps the latency budget honest: there is exactly one shape to measure, so `p95 < 400 ms`
 * means something rather than being true of the cheapest parameterisation.
 */

/** How many rows each section carries. The counts beside them are aggregates over the whole set. */
export const TODAY_SECTION_LIMITS = {
  /** Never collapsed on the screen, so it is the one worth showing a lot of. */
  overdue: 20,
  dueNow: 20,
  laterToday: 20,
  /** A first-contact list longer than this is a staffing problem, not a screen. */
  awaitingFirstContact: 10,
  promisesRunningOut: 10,
} as const;
