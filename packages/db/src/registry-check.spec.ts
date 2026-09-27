import { describe, expect, it } from 'vitest';
import { assertTenantRegistryComplete, findRegistryDrift } from './registry-check.js';

const orgField = { name: 'organizationId' };

describe('tenant model registry drift detection', () => {
  it('accepts a schema whose models are all classified', () => {
    expect(() =>
      assertTenantRegistryComplete([
        { name: 'Organization', fields: [{ name: 'id' }] },
        { name: 'Team', fields: [{ name: 'id' }, orgField] },
        { name: 'Plan', fields: [{ name: 'id' }] },
      ]),
    ).not.toThrow();
  });

  it('catches the dangerous case: a tenant model that would run unscoped', () => {
    // This is the mistake the check exists for — a new table with organizationId that nobody added
    // to TENANT_MODELS would be readable across tenants. The name is deliberately fictional: an
    // earlier version of this test used `Lead`, which stopped failing the moment `Lead` became a
    // real registered model, and a test that cannot fail is worse than no test.
    const model = { name: 'NotARealModelYet', fields: [{ name: 'id' }, orgField] };
    const drift = findRegistryDrift([model]);
    expect(drift.unregisteredTenantModels).toEqual(['NotARealModelYet']);

    expect(() => assertTenantRegistryComplete([model])).toThrow(/would be unscoped/);
  });

  it('catches a registered model that has no tenant column', () => {
    expect(() =>
      assertTenantRegistryComplete([{ name: 'Team', fields: [{ name: 'id' }] }]),
    ).toThrow(/no organizationId/);
  });

  it('forces an explicit decision for unclassified models', () => {
    expect(() =>
      assertTenantRegistryComplete([{ name: 'Mystery', fields: [{ name: 'id' }] }]),
    ).toThrow(/classify them explicitly/);
  });
});
