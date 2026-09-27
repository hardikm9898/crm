import { PLATFORM_MODELS, TENANT_MODELS } from './tenant-models.js';

/**
 * Guards against the one mistake that would quietly undo tenant isolation: adding a
 * model with an `organizationId` column to the schema and forgetting to register it
 * in TENANT_MODELS, leaving it unguarded by the scoping extension.
 *
 * Called from the integration suite, so a drifting registry fails CI (NFR-SEC-1).
 */
export interface RegistryDrift {
  readonly unregisteredTenantModels: string[];
  readonly registeredButNotTenant: string[];
  readonly unclassified: string[];
}

interface ModelMeta {
  readonly name: string;
  readonly fields: readonly { readonly name: string }[];
}

export function findRegistryDrift(models: readonly ModelMeta[]): RegistryDrift {
  const tenant = new Set<string>(TENANT_MODELS);
  const platform = new Set<string>(PLATFORM_MODELS);

  const unregisteredTenantModels: string[] = [];
  const registeredButNotTenant: string[] = [];
  const unclassified: string[] = [];

  for (const model of models) {
    const hasOrgColumn =
      model.fields.some((field) => field.name === 'organizationId') ||
      model.name === 'Organization';

    if (hasOrgColumn && !tenant.has(model.name)) unregisteredTenantModels.push(model.name);
    if (!hasOrgColumn && tenant.has(model.name)) registeredButNotTenant.push(model.name);
    if (!tenant.has(model.name) && !platform.has(model.name)) unclassified.push(model.name);
  }

  return { unregisteredTenantModels, registeredButNotTenant, unclassified };
}

export function assertTenantRegistryComplete(models: readonly ModelMeta[]): void {
  const drift = findRegistryDrift(models);
  const problems: string[] = [];

  if (drift.unregisteredTenantModels.length > 0) {
    problems.push(
      `Models carry organizationId but are NOT in TENANT_MODELS (they would be unscoped): ` +
        drift.unregisteredTenantModels.join(', '),
    );
  }
  if (drift.registeredButNotTenant.length > 0) {
    problems.push(
      `Models are in TENANT_MODELS but have no organizationId: ` +
        drift.registeredButNotTenant.join(', '),
    );
  }
  if (drift.unclassified.length > 0) {
    problems.push(
      `Models are in neither TENANT_MODELS nor PLATFORM_MODELS — classify them explicitly: ` +
        drift.unclassified.join(', '),
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `Tenant model registry is out of sync with the schema.\n- ${problems.join('\n- ')}`,
    );
  }
}
