import { describe, expect, it } from 'vitest';
import {
  INDUSTRY_TEMPLATES,
  WORKFLOW_ACTIONS,
  WORKFLOW_TRIGGERS,
  templateReferencesIn,
  validateWorkflowDefinition,
} from '@leados/shared';
import { CRM_DEFAULT_SEEDS } from './crm-defaults.js';

/**
 * The starter workflows, checked against what a workspace actually has (`FR-AUT-3`).
 *
 * This spec lives in `@leados/db` rather than in `@leados/shared` because it is the only package
 * that can see **both** halves of the question: the templates, and the rows provisioning creates.
 * A starter workflow naming a task type nothing seeds, or a status its own template does not
 * define, would be installed as a draft that can never be published — and nothing else in the
 * product would notice, because a draft is allowed to be incomplete and no test publishes one.
 */
describe('industry template starter workflows', () => {
  const taskTypeNames = new Set(CRM_DEFAULT_SEEDS.taskTypes.map((type) => type.name));

  it('every template names a trigger and actions the registry declares', () => {
    const triggers = new Set(WORKFLOW_TRIGGERS.map((trigger) => trigger.key));
    const actions = new Set(WORKFLOW_ACTIONS.map((action) => action.key));
    for (const template of INDUSTRY_TEMPLATES) {
      for (const workflow of template.workflows ?? []) {
        expect(triggers, `${template.key}: ${workflow.name}`).toContain(workflow.trigger);
        for (const step of workflow.steps) {
          expect(actions, `${template.key}: ${workflow.name}/${step.id}`).toContain(step.action);
        }
      }
    }
  });

  it('every placeholder names a row the template or the common seed creates', () => {
    for (const template of INDUSTRY_TEMPLATES) {
      const statusNames = new Set(template.statuses.map((status) => status.name));
      for (const reference of templateReferencesIn(template)) {
        if ('$taskType' in reference) {
          expect(taskTypeNames, `${template.key}: ${reference.$taskType}`).toContain(
            reference.$taskType,
          );
        } else {
          expect(statusNames, `${template.key}: ${reference.$status}`).toContain(reference.$status);
        }
      }
    }
  });

  /**
   * The same validator `publish` runs, against the definition with its references **resolved** —
   * stood in for by a uuid, because a reference parameter is checked for shape here and for
   * existence by `problemsFor` against the workspace's own rows. A starter workflow that does not
   * pass this is one somebody would open, press Publish on, and be refused.
   */
  it('every starter workflow would publish once its references are resolved', () => {
    const stand_in = '00000000-0000-7000-8000-000000000000';
    const resolve = (params: Readonly<Record<string, unknown>> | undefined) =>
      Object.fromEntries(
        Object.entries(params ?? {}).map(([key, value]) => [
          key,
          typeof value === 'object' && value !== null ? stand_in : value,
        ]),
      );

    for (const template of INDUSTRY_TEMPLATES) {
      for (const workflow of template.workflows ?? []) {
        const problems = validateWorkflowDefinition({
          trigger: { type: workflow.trigger, params: resolve(workflow.triggerParams) },
          steps: workflow.steps.map((step) => ({
            id: step.id,
            action: step.action,
            params: resolve(step.params),
          })),
        });
        expect(problems, `${template.key}: ${workflow.name}`).toEqual([]);
      }
    }
  });

  it('gives every one of the ten industries at least one starter workflow', () => {
    for (const template of INDUSTRY_TEMPLATES) {
      expect((template.workflows ?? []).length, template.key).toBeGreaterThan(0);
    }
  });
});
