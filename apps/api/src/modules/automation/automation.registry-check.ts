import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { WORKFLOW_ACTIONS, WORKFLOW_TRIGGERS } from '@leados/shared';
import { AutomationHandlersService } from './automation-handlers.service.js';

/** The four shapes the engine itself interprets, rather than handing to a handler. */
const CONTROL_ACTIONS = ['wait', 'branch', 'stop', 'enroll'];

/**
 * The registry, reconciled against the engine at boot (`FR-AUT-4`).
 *
 * The fourth time this product does this, and the third time it has caught something: a provider
 * capability read off a near-synonym, a schedule with no processor, and now an action the editor
 * offers that nothing can carry out. A declared action with no handler is a workflow somebody can
 * write, publish, and watch do nothing — and the first exit criterion ("adding an action type
 * requires no engine change") is a claim about exactly this pairing, so a mismatch has to be a
 * failed startup rather than a 500 on somebody's first lead.
 *
 * It runs on `onApplicationBootstrap`, which Nest runs inside `app.init()` — so every application
 * built from these modules is checked, including the ones the tests build. A check installed from
 * `main.ts` would be absent from every one of them, which is the lesson the request-log hook paid
 * for.
 */
@Injectable()
export class AutomationRegistryCheck implements OnApplicationBootstrap {
  constructor(private readonly handlers: AutomationHandlersService) {}

  onApplicationBootstrap(): void {
    const handled = new Set(this.handlers.handledActions());
    const problems: string[] = [];

    for (const action of WORKFLOW_ACTIONS) {
      if (action.control) {
        if (!CONTROL_ACTIONS.includes(action.key)) {
          problems.push(`“${action.key}” is declared as a control shape the engine does not know`);
        }
        if (handled.has(action.key)) {
          problems.push(
            `“${action.key}” is both a control shape and a handler, which is two answers`,
          );
        }
        continue;
      }
      if (!handled.has(action.key)) {
        problems.push(`“${action.key}” is offered by the editor and no handler can carry it out`);
      }
    }

    const declared = new Set(WORKFLOW_ACTIONS.map((action) => action.key));
    for (const key of handled) {
      if (!declared.has(key)) {
        // The other direction matters too: a handler nothing declares is dead code that looks like
        // a feature, and the day somebody adds the registry entry it may not do what they expect.
        problems.push(`there is a handler for “${key}” and the registry does not offer it`);
      }
    }

    for (const trigger of WORKFLOW_TRIGGERS) {
      if (trigger.subject !== 'lead') {
        // Every table the engine writes carries `lead_id` with a composite FK. A trigger about
        // anything else needs a column before it needs a screen.
        problems.push(
          `“${trigger.key}” is about a ${trigger.subject}, which the engine cannot run`,
        );
      }
    }

    if (problems.length > 0) {
      throw new Error(
        `The automation registry and the engine disagree:\n  - ${problems.join('\n  - ')}`,
      );
    }
  }
}
