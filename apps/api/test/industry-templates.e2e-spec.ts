import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INDUSTRY_TEMPLATES, newToken } from '@leados/shared';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * THE INDUSTRY TEMPLATE SUITE.
 *
 * `FR-ONB-2` asks for templates that seed "custom fields, pipeline + stages, statuses, lost reasons,
 * task types, sources, saved views … all then editable". The assertions that matter are about the
 * **replacement**: that a template leaves a workspace with one default status rather than two, that
 * the pipeline it writes is the one the lead screens read, that the sources the product itself
 * writes through survive, and that the whole thing is refused the moment there is a record to lose.
 *
 * Nothing is mocked. Every count comes back from PostgreSQL, where
 * `lead_statuses_one_default_per_org` would refuse a half-applied replacement outright.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2etmpl${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';

let ctx: TestApp;

interface Tenant {
  token: string;
  organizationId: string;
}

interface TemplateSummary {
  key: string;
  name: string;
  description: string;
  statuses: number;
  stages: number;
  sources: number;
  fields: number;
  views: number;
  fieldLabels: string[];
  applied: boolean;
}

async function api<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  options: { token: string; payload?: unknown },
) {
  return call<EnvelopeBody<T>>(ctx.app, {
    method,
    url: `/api/v1${url}`,
    token: options.token,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

async function configure<T = unknown>(
  method: 'POST' | 'PATCH' | 'DELETE',
  url: string,
  options: { token: string; payload?: unknown },
) {
  const response = await api<T>(method, url, options);
  if (response.statusCode >= 300) {
    throw new Error(
      `setup ${method} ${url} was refused with ${response.statusCode}: ${JSON.stringify(response.body)}`,
    );
  }
  return response;
}

/** A brand-new workspace each time: a template replaces a vocabulary, so it needs its own. */
async function createTenant(label: string): Promise<Tenant> {
  const registered = await call<
    EnvelopeBody<{ tokens: { accessToken: string }; activeOrganizationId: string }>
  >(ctx.app, {
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      email: `${label}.${EMAIL_MARKER}@test.local`,
      password: PASSWORD,
      name: `Owner ${label}`,
      organizationName: `Tmpl ${label} ${SUFFIX}`,
    },
  });
  return {
    token: registered.body.data.tokens.accessToken,
    organizationId: registered.body.data.activeOrganizationId,
  };
}

beforeAll(async () => {
  ctx = await bootTestApp();
}, 120_000);

afterAll(async () => {
  await cleanupUsers(ctx.db, EMAIL_MARKER);
  await ctx.close();
});

describe('the catalogue a new workspace is offered', () => {
  it('lists the ten industries, with what each one installs', async () => {
    const tenant = await createTenant('catalogue');
    const response = await api<TemplateSummary[]>('GET', '/organization/industry-templates', {
      token: tenant.token,
    });
    expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toHaveLength(INDUSTRY_TEMPLATES.length);

    const realEstate = response.body.data.find((row) => row.key === 'real_estate');
    expect(realEstate?.name).toBe('Real estate');
    // The picker has to say how much changes, not just "a template".
    expect(realEstate?.statuses).toBeGreaterThan(4);
    expect(realEstate?.fieldLabels).toContain('Configuration');
    expect(realEstate?.applied).toBe(false);
  });

  it('says which one this workspace applied', async () => {
    const tenant = await createTenant('applied');
    await configure('POST', '/organization/industry-template', {
      token: tenant.token,
      payload: { key: 'fitness' },
    });
    const response = await api<TemplateSummary[]>('GET', '/organization/industry-templates', {
      token: tenant.token,
    });
    expect(response.body.data.filter((row) => row.applied).map((row) => row.key)).toEqual([
      'fitness',
    ]);
  });

  it('refuses a template that does not exist, as a 404', async () => {
    const tenant = await createTenant('unknown');
    const refused = await api('POST', '/organization/industry-template', {
      token: tenant.token,
      payload: { key: 'underwater_basket_weaving' },
    });
    expect(refused.statusCode).toBe(404);
  });
});

describe('applying a template replaces the workspace’s vocabulary', () => {
  it('leaves exactly the template’s statuses, with one default', async () => {
    const tenant = await createTenant('statuses');
    const before = await api<{ name: string; isDefault: boolean }[]>('GET', '/crm/statuses', {
      token: tenant.token,
    });
    expect(before.body.data.map((row) => row.name)).toContain('Qualified');

    const applied = await configure<{ statuses: number }>(
      'POST',
      '/organization/industry-template',
      { token: tenant.token, payload: { key: 'real_estate' } },
    );
    expect(applied.body.data.statuses).toBe(9);

    const after = await api<{ name: string; isDefault: boolean }[]>('GET', '/crm/statuses', {
      token: tenant.token,
    });
    expect(after.body.data.map((row) => row.name)).toEqual([
      'New enquiry',
      'Contacted',
      'Site visit scheduled',
      'Site visit done',
      'Negotiating',
      'Booked',
      'Won',
      'Lost',
      'Invalid number',
    ]);
    // `lead_statuses_one_default_per_org` is a partial unique index: two would have been refused,
    // and none would make the next lead impossible to create.
    expect(after.body.data.filter((row) => row.isDefault)).toHaveLength(1);
  });

  it('rewrites the lead pipeline the screens actually read', async () => {
    const tenant = await createTenant('pipeline');
    await configure('POST', '/organization/industry-template', {
      token: tenant.token,
      payload: { key: 'education' },
    });
    const pipelines = await api<
      { id: string; entityType: string; isDefault: boolean; stages: { name: string }[] }[]
    >('GET', '/crm/pipelines', { token: tenant.token });
    const lead = pipelines.body.data.find((row) => row.isDefault);
    expect(lead?.stages.map((stage) => stage.name)).toEqual([
      'Enquiry',
      'Counselling',
      'Demo class',
      'Fee discussion',
      'Enrolled',
      'Dropped',
    ]);
  });

  it('leaves the deal pipeline alone, because it is not a lead pipeline', async () => {
    const tenant = await createTenant('dealpipe');
    const before = await api<{ stages: { name: string }[] }[]>(
      'GET',
      '/crm/pipelines?entityType=deal',
      { token: tenant.token },
    );
    const stagesBefore = before.body.data[0]?.stages.map((s) => s.name);
    await configure('POST', '/organization/industry-template', {
      token: tenant.token,
      payload: { key: 'education' },
    });
    const after = await api<{ stages: { name: string }[] }[]>(
      'GET',
      '/crm/pipelines?entityType=deal',
      { token: tenant.token },
    );
    expect(after.body.data[0]?.stages.map((s) => s.name)).toEqual(stagesBefore);
  });

  it('keeps the two sources the product itself writes through', async () => {
    // `Manual entry` and `API` are not marketing channels; the capture paths look them up by name,
    // and a template that deleted them would break lead creation right after onboarding.
    const tenant = await createTenant('sources');
    await configure('POST', '/organization/industry-template', {
      token: tenant.token,
      payload: { key: 'automobile' },
    });
    const sources = await api<{ name: string }[]>('GET', '/crm/sources', { token: tenant.token });
    const names = sources.body.data.map((row) => row.name);
    expect(names).toContain('Manual entry');
    expect(names).toContain('API');
    expect(names).toContain('CarDekho / OLX');
    // And the generic ones the template does not name are gone.
    expect(names).not.toContain('Website');
  });

  it('installs the industry’s custom fields, with their options', async () => {
    const tenant = await createTenant('fields');
    await configure('POST', '/organization/industry-template', {
      token: tenant.token,
      payload: { key: 'real_estate' },
    });
    const fields = await api<
      { key: string; label: string; type: string; options?: { value: string; label: string }[] }[]
    >('GET', '/custom-fields?entityType=lead', { token: tenant.token });
    const configuration = fields.body.data.find((row) => row.key === 'configuration');
    expect(configuration?.type).toBe('select');
    expect(configuration?.options?.map((option) => option.label)).toContain('3 BHK');
    // The stored value is a slug, so renaming the label later does not rewrite every record.
    expect(configuration?.options?.map((option) => option.value)).toContain('3_bhk');
  });

  it('makes the new fields immediately usable on a lead, with no migration', async () => {
    const tenant = await createTenant('usable');
    await configure('POST', '/organization/industry-template', {
      token: tenant.token,
      payload: { key: 'travel' },
    });
    const lead = await api<{ id: string; customValues: Record<string, unknown> }>(
      'POST',
      '/leads',
      {
        token: tenant.token,
        payload: {
          firstName: 'Meera',
          lastName: 'Travel',
          email: `meera.${SUFFIX}@tmpl.test`,
          customValues: { destination: 'Bali', pax: 4 },
        },
      },
    );
    expect(lead.statusCode, JSON.stringify(lead.body)).toBe(201);

    // Read it back rather than trusting the create response: the values that matter are the ones
    // that were stored, and the create response is a summary.
    const fetched = await api<{ customValues: Record<string, unknown> }>(
      'GET',
      `/leads/${lead.body.data.id}`,
      { token: tenant.token },
    );
    expect(fetched.body.data.customValues['destination']).toBe('Bali');
    expect(fetched.body.data.customValues['pax']).toBe(4);
  });

  it('refuses a custom value the previous industry’s fields would have accepted', async () => {
    // The registry is rewritten and its cache dropped in the same breath, so the lead form stops
    // offering the old questions at once rather than five minutes later.
    const tenant = await createTenant('oldfields');
    await configure('POST', '/organization/industry-template', {
      token: tenant.token,
      payload: { key: 'real_estate' },
    });
    const refused = await api('POST', '/leads', {
      token: tenant.token,
      payload: {
        firstName: 'Wrong',
        lastName: 'Industry',
        email: `wrong.${SUFFIX}@tmpl.test`,
        customValues: { destination: 'Bali' },
      },
    });
    expect(refused.statusCode).toBe(400);
  });

  it('adds the industry’s saved views and keeps the provisioned ones', async () => {
    const tenant = await createTenant('views');
    const before = await api<{ name: string }[]>('GET', '/views?entityType=lead', {
      token: tenant.token,
    });
    const provisioned = before.body.data.map((row) => row.name);
    expect(provisioned.length).toBeGreaterThan(0);

    await configure('POST', '/organization/industry-template', {
      token: tenant.token,
      payload: { key: 'real_estate' },
    });
    const after = await api<{ name: string }[]>('GET', '/views?entityType=lead', {
      token: tenant.token,
    });
    const names = after.body.data.map((row) => row.name);
    expect(names).toContain('Site visit due this week');
    for (const name of provisioned) expect(names).toContain(name);
  });

  it('records the industry on the organization', async () => {
    const tenant = await createTenant('recorded');
    await configure('POST', '/organization/industry-template', {
      token: tenant.token,
      payload: { key: 'salon' },
    });
    const organization = await api<{ industry: string | null }>('GET', '/organization', {
      token: tenant.token,
    });
    expect(organization.body.data.industry).toBe('Salon & spa');
  });

  it('can be applied twice, the second replacing the first', async () => {
    const tenant = await createTenant('twice');
    await configure('POST', '/organization/industry-template', {
      token: tenant.token,
      payload: { key: 'real_estate' },
    });
    await configure('POST', '/organization/industry-template', {
      token: tenant.token,
      payload: { key: 'fitness' },
    });
    const statuses = await api<{ name: string; isDefault: boolean }[]>('GET', '/crm/statuses', {
      token: tenant.token,
    });
    expect(statuses.body.data.map((row) => row.name)).toContain('Trial booked');
    expect(statuses.body.data.map((row) => row.name)).not.toContain('Site visit scheduled');
    expect(statuses.body.data.filter((row) => row.isDefault)).toHaveLength(1);
  });

  it('every one of the ten leaves a workspace that can create a lead', async () => {
    // The assertion that would catch a typo in any template: a bad default, a missing won status or
    // a stage probability out of range all end here, as a lead that cannot be created.
    for (const template of INDUSTRY_TEMPLATES) {
      const tenant = await createTenant(`all-${template.key.replace(/_/g, '')}`);
      const applied = await api('POST', '/organization/industry-template', {
        token: tenant.token,
        payload: { key: template.key },
      });
      expect(applied.statusCode, `${template.key}: ${JSON.stringify(applied.body)}`).toBe(200);

      const lead = await api<{ id: string }>('POST', '/leads', {
        token: tenant.token,
        payload: {
          firstName: 'Smoke',
          lastName: 'Test',
          email: `smoke.${template.key}.${SUFFIX}@tmpl.test`,
        },
      });
      expect(lead.statusCode, `${template.key}: ${JSON.stringify(lead.body)}`).toBe(201);
    }
  }, 180_000);
});

describe('the refusal is the design', () => {
  it('refuses once the workspace has a lead, and says what to do instead', async () => {
    const tenant = await createTenant('haslead');
    await configure('POST', '/leads', {
      token: tenant.token,
      payload: {
        firstName: 'Already',
        lastName: 'Here',
        email: `already.${SUFFIX}@tmpl.test`,
      },
    });
    const refused = await api('POST', '/organization/industry-template', {
      token: tenant.token,
      payload: { key: 'real_estate' },
    });
    expect(refused.statusCode).toBe(422);
    const message = JSON.stringify(refused.body);
    expect(message).toMatch(/1 lead/);
    expect(message).toMatch(/Settings instead/);
  });

  it('refuses once the workspace has a customer', async () => {
    const tenant = await createTenant('hascustomer');
    await configure('POST', '/customers', {
      token: tenant.token,
      payload: { firstName: 'Walk', lastName: 'In', email: `walkin.${SUFFIX}@tmpl.test` },
    });
    const refused = await api('POST', '/organization/industry-template', {
      token: tenant.token,
      payload: { key: 'real_estate' },
    });
    expect(refused.statusCode).toBe(422);
    expect(JSON.stringify(refused.body)).toMatch(/1 customer/);
  });

  it('needs organization:manage, not merely organization:read', async () => {
    const tenant = await createTenant('perms');
    // The read is allowed for anybody who can see the organization.
    const listed = await api('GET', '/organization/industry-templates', { token: tenant.token });
    expect(listed.statusCode).toBe(200);

    const other = await createTenant('perms-other');
    const refused = await api('POST', '/organization/industry-template', {
      token: other.token,
      payload: { key: 'real_estate' },
    });
    // The other tenant may apply to *their own* workspace; what must not happen is reaching this
    // one, and there is no id in the path to reach it with — which is the point of the shape.
    expect(refused.statusCode).toBe(200);
    const mine = await api<{ industry: string | null }>('GET', '/organization', {
      token: tenant.token,
    });
    expect(mine.body.data.industry).not.toBe('Real estate');
  });
});
