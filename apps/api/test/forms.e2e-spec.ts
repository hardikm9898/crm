import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newToken } from '@leados/shared';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * THE CAPTURE FORMS SUITE.
 *
 * `FR-CAP-2` asks for forms with dynamic fields, multi-step, consent, a honeypot, a rate limit and
 * a thank-you; `FR-CAP-3` that every capture persists its payload whether or not a lead was
 * created; `FR-CAP-4` that there is **one** ingestion path; `FR-CAP-5` that unknown fields are
 * accepted rather than refused.
 *
 * The assertions that matter are the ones about the public endpoints, because they are the only
 * part of this product a stranger can reach:
 *
 *  * what a form may ask for at all — a field list that offered `statusId` or `assignedUserId`
 *    would let anybody set them;
 *  * what the public definition gives away — this response is readable by anybody with the URL;
 *  * that a capture goes through the same path a manual lead does, so duplicate detection,
 *    assignment, the SLA clock and the timeline all happen;
 *  * that a submission is recorded **before** the capture is attempted, and that the one which
 *    failed is still a row;
 *  * that a bot is thanked rather than told;
 *  * that one workspace cannot read, edit or capture into another's form.
 *
 * Nothing is mocked: the submissions go through the real public controller, and the leads they
 * create are read back through the real lead endpoints.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2eform${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';

interface Tenant {
  token: string;
  organizationId: string;
  userId: string;
}

interface FormBody {
  id: string;
  name: string;
  slug: string;
  publicKey: string;
  type: string;
  isActive: boolean;
  submissionCount: number;
  stepCount: number;
  settings: Record<string, unknown>;
  fields: {
    id: string;
    standardFieldKey: string | null;
    customFieldDefinitionId: string | null;
    label: string;
    isRequired: boolean;
    sortOrder: number;
    stepIndex: number;
  }[];
}

interface PublicFormBody {
  name: string;
  organizationName: string;
  honeypotField: string;
  steps: number;
  settings: Record<string, unknown>;
  fields: {
    name: string;
    label: string;
    kind: string;
    required: boolean;
    stepIndex: number;
    options: { value: string; label: string }[] | null;
  }[];
}

let ctx: TestApp;
let orgA: Tenant;
let orgB: Tenant;
/** A `select` custom field of org A's, so a form can ask something the workspace invented. */
let serviceFieldId: string;

async function api<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  options: { token?: string; payload?: unknown } = {},
) {
  return call<EnvelopeBody<T>>(ctx.app, {
    method,
    url: `/api/v1${url}`,
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

/** A setup call that throws rather than letting a silent non-2xx take an assertion with it. */
async function setup<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  options: { token?: string; payload?: unknown } = {},
): Promise<T> {
  const response = await api<T>(method, url, options);
  if (response.statusCode >= 300) {
    throw new Error(`${method} ${url} → ${response.statusCode} ${JSON.stringify(response.body)}`);
  }
  return response.body.data;
}

async function registerTenant(label: string): Promise<Tenant> {
  const registered = await call<
    EnvelopeBody<{
      tokens: { accessToken: string };
      activeOrganizationId: string;
      user: { id: string };
    }>
  >(ctx.app, {
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      email: `${label}.${EMAIL_MARKER}@test.local`,
      password: PASSWORD,
      name: 'Meera Joshi',
      organizationName: `Forms ${label} ${SUFFIX}`,
    },
  });
  return {
    token: registered.body.data.tokens.accessToken,
    organizationId: registered.body.data.activeOrganizationId,
    userId: registered.body.data.user.id,
  };
}

/** A complete, usable form: two steps, a required custom field, consent and a free-text message. */
async function createForm(over: Record<string, unknown> = {}, token = orgA.token) {
  return setup<FormBody>('POST', '/forms', {
    token,
    payload: {
      name: `Website enquiry ${newToken(3).replace(/[^a-zA-Z0-9]/g, '')}`,
      settings: { thankYouMessage: 'Thanks — we will call you today.', submitLabel: 'Send' },
      fields: [
        { standardFieldKey: 'fullName', label: 'Your name', isRequired: true },
        { standardFieldKey: 'phone', label: 'Mobile number', isRequired: true },
        { standardFieldKey: 'email', label: 'Email address' },
        {
          customFieldDefinitionId: serviceFieldId,
          label: 'Which service',
          isRequired: true,
          stepIndex: 1,
        },
        { standardFieldKey: 'message', label: 'What do you need?', stepIndex: 1 },
        { standardFieldKey: 'consentWhatsapp', label: 'You may message me', stepIndex: 1 },
      ],
      ...over,
    },
  });
}

let phoneCounter = 0;
/** A number nobody else in this run uses, so duplicate detection is exercised deliberately. */
function freshPhone(): string {
  phoneCounter += 1;
  return `+9198450${String(10_000 + phoneCounter).slice(0, 5)}`;
}

function answers(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'standard:fullName': 'Rohit Kulkarni',
    'standard:phone': freshPhone(),
    [`custom:${serviceFieldId}`]: 'interiors',
    ...over,
  };
}

beforeAll(async () => {
  ctx = await bootTestApp();
  orgA = await registerTenant('orga');
  orgB = await registerTenant('orgb');
  const definition = await setup<{ id: string }>('POST', '/custom-fields', {
    token: orgA.token,
    payload: {
      entityType: 'lead',
      key: 'service',
      label: 'Which service',
      type: 'select',
      options: [
        { value: 'interiors', label: 'Interiors' },
        { value: 'construction', label: 'Construction' },
      ],
    },
  });
  serviceFieldId = definition.id;
}, 120_000);

afterAll(async () => {
  await cleanupUsers(ctx.db, EMAIL_MARKER);
  await ctx.close();
});

describe('what a form may ask a stranger for (FR-CAP-2)', () => {
  it('offers the standard questions, and none a stranger must not set', async () => {
    const options = await setup<{
      standardFields: { key: string; label: string; kind: string }[];
      contactKeys: string[];
    }>('GET', '/forms/builder-options', { token: orgA.token });

    const keys = options.standardFields.map((field) => field.key);
    expect(keys).toContain('phone');
    expect(keys).toContain('consentWhatsapp');
    // The security assertion of this suite: a public form cannot offer to set the workspace's own
    // decisions. The day somebody adds one of these to the list, this fails.
    for (const forbidden of [
      'statusId',
      'stageId',
      'pipelineId',
      'assignedUserId',
      'score',
      'leadSourceId',
      'tagIds',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    expect(options.contactKeys).toContain('phone');
  });

  it('offers this workspace’s own lead fields, with their choices', async () => {
    const options = await setup<{
      customFields: { id: string; label: string; type: string; options: { value: string }[] }[];
    }>('GET', '/forms/builder-options', { token: orgA.token });
    const service = options.customFields.find((field) => field.id === serviceFieldId);
    expect(service?.type).toBe('select');
    expect(service?.options.map((option) => option.value)).toEqual(['interiors', 'construction']);
  });

  it('refuses a field that is not on the list', async () => {
    const refused = await api('POST', '/forms', {
      token: orgA.token,
      payload: { name: 'Sneaky', fields: [{ standardFieldKey: 'statusId', label: 'Status' }] },
    });
    expect(refused.statusCode).toBe(400);
  });

  it('refuses a form that cannot reach anybody', async () => {
    const refused = await api<{ error: { details: { code: string }[] } }>('POST', '/forms', {
      token: orgA.token,
      payload: { name: 'Unreachable', fields: [{ standardFieldKey: 'city', label: 'City' }] },
    });
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('NO_WAY_TO_REACH_THEM');
  });

  it('refuses the same question twice, and a custom field that does not exist', async () => {
    const twice = await api('POST', '/forms', {
      token: orgA.token,
      payload: {
        name: 'Twice',
        fields: [
          { standardFieldKey: 'phone', label: 'Phone' },
          { standardFieldKey: 'phone', label: 'Mobile' },
        ],
      },
    });
    expect(twice.statusCode).toBe(400);

    const unknown = await api('POST', '/forms', {
      token: orgA.token,
      payload: {
        name: 'Unknown field',
        fields: [
          { standardFieldKey: 'phone', label: 'Phone' },
          { customFieldDefinitionId: orgA.userId, label: 'Nonsense' },
        ],
      },
    });
    expect(unknown.statusCode).toBe(400);
  });

  it('refuses a field that is both a standard and a custom question', async () => {
    const both = await api('POST', '/forms', {
      token: orgA.token,
      payload: {
        name: 'Both',
        fields: [
          {
            standardFieldKey: 'phone',
            customFieldDefinitionId: serviceFieldId,
            label: 'Confused',
          },
        ],
      },
    });
    expect(both.statusCode).toBe(400);
  });
});

describe('a form the workspace owns', () => {
  it('is created with a slug, a long public key and its questions in order', async () => {
    const form = await createForm({ name: 'Website enquiry' });
    expect(form.slug).toBe('website-enquiry');
    expect(form.publicKey.length).toBeGreaterThanOrEqual(16);
    expect(form.fields.map((field) => field.label)).toEqual([
      'Your name',
      'Mobile number',
      'Email address',
      'Which service',
      'What do you need?',
      'You may message me',
    ]);
    expect(form.fields.map((field) => field.sortOrder)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(form.stepCount).toBe(2);
    expect(form.submissionCount).toBe(0);
  });

  it('refuses a slug another live form already uses, and reuses a deleted one’s', async () => {
    const first = await createForm({ name: 'Launch offer', slug: `launch-${SUFFIX}` });
    const clash = await api('POST', '/forms', {
      token: orgA.token,
      payload: {
        name: 'Launch offer again',
        slug: `launch-${SUFFIX}`,
        fields: [{ standardFieldKey: 'phone', label: 'Phone' }],
      },
    });
    expect(clash.statusCode).toBe(400);

    // Nothing has been captured through it, so it can go — and its address becomes free, which is
    // what the partial unique index is for.
    await setup('DELETE', `/forms/${first.id}`, { token: orgA.token });
    const reused = await createForm({ name: 'Launch offer', slug: `launch-${SUFFIX}` });
    expect(reused.slug).toBe(`launch-${SUFFIX}`);
  });

  it('replaces the whole question set at once', async () => {
    const form = await createForm();
    const updated = await setup<FormBody>('PUT', `/forms/${form.id}/fields`, {
      token: orgA.token,
      payload: {
        fields: [
          { standardFieldKey: 'phone', label: 'WhatsApp number', isRequired: true },
          { standardFieldKey: 'city', label: 'Which city', stepIndex: 0 },
        ],
      },
    });
    expect(updated.fields.map((field) => field.label)).toEqual(['WhatsApp number', 'Which city']);
    expect(updated.stepCount).toBe(1);
  });

  it('cannot be deleted once a lead came in through it, and says what to do instead', async () => {
    const form = await createForm();
    const submitted = await api('POST', `/public/forms/${form.publicKey}/submissions`, {
      payload: { answers: answers() },
    });
    expect(submitted.statusCode).toBe(201);

    const refused = await api<{ error: { message: string } }>('DELETE', `/forms/${form.id}`, {
      token: orgA.token,
    });
    // 422, not 400: the request is well-formed and the rule is a business one.
    expect(refused.statusCode).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('Deactivate it instead');
  });
});

describe('what a stranger can see (FR-CAP-2)', () => {
  it('reads the form, its copy and its fields — and nothing else', async () => {
    const form = await createForm();
    const definition = await setup<PublicFormBody>('GET', `/public/forms/${form.publicKey}`);
    expect(definition.name).toBe(form.name);
    expect(definition.organizationName).toContain('Forms orga');
    expect(definition.honeypotField).toBe('website_url');
    expect(definition.steps).toBe(2);
    expect(definition.fields.find((field) => field.name === 'standard:phone')?.kind).toBe('phone');
    expect(
      definition.fields.find((field) => field.name === `custom:${serviceFieldId}`)?.options,
    ).toEqual([
      { value: 'interiors', label: 'Interiors' },
      { value: 'construction', label: 'Construction' },
    ]);

    // This response is readable by anybody with the URL. Everything in it is deliberate, and the
    // things not in it are what a competitor would otherwise learn.
    const serialised = JSON.stringify(definition);
    expect(serialised).not.toContain('pipeline');
    expect(serialised).not.toContain('assignmentRule');
    expect(serialised).not.toContain('submissionCount');
    expect(serialised).not.toContain(orgA.organizationId);
  });

  it('answers 404 for a key that never existed, and for a form switched off', async () => {
    const madeUp = await api('GET', '/public/forms/not-a-real-key-at-all-here');
    expect(madeUp.statusCode).toBe(404);

    const form = await createForm();
    await setup('PATCH', `/forms/${form.id}`, { token: orgA.token, payload: { isActive: false } });
    const off = await api('GET', `/public/forms/${form.publicKey}`);
    // The same answer as a made-up URL, deliberately: a deactivated form must not be
    // distinguishable from one that never existed, or the key becomes an oracle.
    expect(off.statusCode).toBe(404);
  });

  it('stops answering the old URL the moment the key is rotated', async () => {
    const form = await createForm();
    const rotated = await setup<FormBody>('POST', `/forms/${form.id}/rotate-key`, {
      token: orgA.token,
    });
    expect(rotated.publicKey).not.toBe(form.publicKey);
    expect((await api('GET', `/public/forms/${form.publicKey}`)).statusCode).toBe(404);
    expect((await api('GET', `/public/forms/${rotated.publicKey}`)).statusCode).toBe(200);
  });
});

describe('a capture goes through the one ingestion path (FR-CAP-4)', () => {
  it('becomes a lead with the phone normalised, the name split and the consent recorded', async () => {
    const form = await createForm();
    const phone = freshPhone();
    const submitted = await api<{ received: boolean; message: string; redirectUrl: string | null }>(
      'POST',
      `/public/forms/${form.publicKey}/submissions`,
      {
        payload: {
          answers: {
            'standard:fullName': 'Rohit Kulkarni',
            'standard:phone': phone.replace('+91', '').replace(/^/, '0'),
            'standard:email': `rohit.${SUFFIX}@visitor.test`,
            [`custom:${serviceFieldId}`]: 'interiors',
            'standard:message': 'Need a 3BHK interior done before Diwali',
            'standard:consentWhatsapp': 'on',
          },
          utm: { utm_source: 'google', utm_medium: 'cpc', gclid: 'noise' },
          pageUrl: 'https://example.test/contact',
          referrer: 'https://www.google.com/',
        },
      },
    );
    expect(submitted.statusCode).toBe(201);
    expect(submitted.body.data.message).toBe('Thanks — we will call you today.');

    const found = await setup<{ id: string }[]>(
      'GET',
      `/leads?search=${encodeURIComponent(phone.slice(-8))}`,
      {
        token: orgA.token,
      },
    );
    expect(found).toHaveLength(1);
    // Read back rather than asserted off the capture's own response: the create response is the
    // capture's shape, not the detail presenter's.
    const lead = await setup<{
      phone: string | null;
      firstName: string | null;
      lastName: string | null;
      email: string | null;
      createdVia: string;
      consent: { whatsapp: boolean };
      customValues: Record<string, unknown>;
      utm: Record<string, string>;
      landingPageUrl: string | null;
      touchpoints: { channel: string; utm: Record<string, string> }[];
    }>('GET', `/leads/${found[0]!.id}`, { token: orgA.token });

    expect(lead.phone).toBe(phone);
    expect(lead.firstName).toBe('Rohit');
    expect(lead.lastName).toBe('Kulkarni');
    expect(lead.createdVia).toBe('form');
    expect(lead.consent.whatsapp).toBe(true);
    expect(lead.customValues['service']).toBe('interiors');
    // Five keys kept, the ad-click id dropped: this ends up in a JSONB column every report reads.
    expect(lead.utm).toEqual({ utm_source: 'google', utm_medium: 'cpc' });
    expect(lead.landingPageUrl).toBe('https://example.test/contact');
    expect(lead.touchpoints[0]?.channel).toBe('form');
  });

  it('writes what they typed to the timeline, where whoever calls them will read it', async () => {
    const form = await createForm();
    const phone = freshPhone();
    await setup('POST', `/public/forms/${form.publicKey}/submissions`, {
      payload: {
        answers: {
          'standard:fullName': 'Anita Rao',
          'standard:phone': phone,
          [`custom:${serviceFieldId}`]: 'construction',
          'standard:message': 'Plot in Wakad, want a quote by Friday',
        },
      },
    });

    const found = await setup<{ id: string }[]>(
      'GET',
      `/leads?search=${encodeURIComponent(phone.slice(-8))}`,
      {
        token: orgA.token,
      },
    );
    const timeline = await setup<{ type: string; payload: Record<string, unknown> }[]>(
      'GET',
      `/leads/${found[0]!.id}/timeline?limit=30`,
      { token: orgA.token },
    );
    const entry = timeline.find((row) => row.type === 'lead.form_submitted');
    expect(entry, 'the form submission has to be on the timeline (rule 6)').toBeDefined();
    expect(entry?.payload['formName']).toBe(form.name);
    expect(JSON.stringify(entry?.payload['answers'])).toContain('Wakad');
    // Two entries at the same instant, saying different things: where they came from, and what
    // they said. The same lesson as `lead.converted` beside `customer.created`.
    expect(timeline.some((row) => row.type === 'lead.source_captured')).toBe(true);
  });

  it('starts the first-response clock, because a form capture is a promise like any other', async () => {
    const form = await createForm();
    const phone = freshPhone();
    await setup('POST', `/public/forms/${form.publicKey}/submissions`, {
      payload: {
        answers: {
          'standard:fullName': 'Clock Test',
          'standard:phone': phone,
          [`custom:${serviceFieldId}`]: 'interiors',
        },
      },
    });
    const found = await setup<{ id: string }[]>(
      'GET',
      `/leads?search=${encodeURIComponent(phone.slice(-8))}`,
      {
        token: orgA.token,
      },
    );
    const clocks = await setup<{ target: string; state: string }[]>(
      'GET',
      `/sla/clocks?leadId=${found[0]!.id}`,
      { token: orgA.token },
    );
    expect(clocks.map((clock) => clock.target)).toContain('first_response');
  });

  it('attaches a repeat capture to the lead that already exists (FR-DUP-3)', async () => {
    const form = await createForm();
    const phone = freshPhone();
    const payload = (message: string) => ({
      answers: {
        'standard:fullName': 'Repeat Visitor',
        'standard:phone': phone,
        [`custom:${serviceFieldId}`]: 'interiors',
        'standard:message': message,
      },
    });
    await setup('POST', `/public/forms/${form.publicKey}/submissions`, {
      payload: payload('First enquiry'),
    });
    await setup('POST', `/public/forms/${form.publicKey}/submissions`, {
      payload: payload('Also want the terrace done'),
    });

    const found = await setup<{ id: string }[]>(
      'GET',
      `/leads?search=${encodeURIComponent(phone.slice(-8))}`,
      {
        token: orgA.token,
      },
    );
    expect(found, 'one person, one lead').toHaveLength(1);
    const lead = await setup<{ touchpoints: unknown[] }>('GET', `/leads/${found[0]!.id}`, {
      token: orgA.token,
    });
    expect(lead.touchpoints).toHaveLength(2);

    const timeline = await setup<{ type: string; payload: Record<string, unknown> }[]>(
      'GET',
      `/leads/${found[0]!.id}/timeline?limit=40`,
      { token: orgA.token },
    );
    // The second thing they said has to survive: enrichment only fills blanks, so the timeline is
    // the only place "also want the terrace done" is kept.
    expect(JSON.stringify(timeline)).toContain('terrace');

    const submissions = await setup<{ status: string }[]>(
      'GET',
      `/forms/submissions?formId=${form.id}`,
      {
        token: orgA.token,
      },
    );
    expect(submissions.map((row) => row.status).sort()).toEqual(['duplicate', 'processed']);
  });
});

describe('every submission is kept, whatever became of it (FR-CAP-3, FR-CAP-5)', () => {
  it('keeps the whole payload, including answers to questions the form does not ask', async () => {
    const form = await createForm();
    await setup('POST', `/public/forms/${form.publicKey}/submissions`, {
      payload: { answers: { ...answers(), colour_preference: 'blue', 'standard:city': 'Pune' } },
    });
    const submissions = await setup<{ status: string; answers: Record<string, unknown> }[]>(
      'GET',
      `/forms/submissions?formId=${form.id}`,
      { token: orgA.token },
    );
    expect(submissions[0]?.status).toBe('processed');
    // `FR-CAP-5`: ingestion accepts unknown fields rather than failing, and the answer is kept so
    // somebody can decide later whether it deserves a field of its own.
    expect(submissions[0]?.answers['colour_preference']).toBe('blue');
  });

  it('records a refused answer as a refusal, with the reason, and creates no lead', async () => {
    const form = await createForm();
    const refused = await api<{
      error: { details: { field: string; code: string; message: string }[] };
    }>('POST', `/public/forms/${form.publicKey}/submissions`, {
      payload: { answers: { 'standard:fullName': 'No Phone' } },
    });
    expect(refused.statusCode).toBe(400);
    const details = JSON.stringify(refused.body);
    // A sentence a visitor can act on, under the field it belongs to — not a constraint name.
    expect(details).toContain('Mobile number is needed.');
    expect(details).toContain('standard:phone');

    const submissions = await setup<{ status: string; error: string | null; lead: unknown }[]>(
      'GET',
      `/forms/submissions?formId=${form.id}`,
      { token: orgA.token },
    );
    expect(submissions[0]?.status).toBe('rejected');
    expect(submissions[0]?.error).toContain('Mobile number is needed.');
    expect(submissions[0]?.lead).toBeNull();
  });

  it('refuses an email that is not one, by name', async () => {
    const form = await createForm();
    const refused = await api('POST', `/public/forms/${form.publicKey}/submissions`, {
      payload: { answers: { ...answers(), 'standard:email': 'nope' } },
    });
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('NOT_AN_EMAIL');
  });

  it('refuses a choice the form never offered', async () => {
    const form = await createForm();
    const refused = await api('POST', `/public/forms/${form.publicKey}/submissions`, {
      payload: { answers: { ...answers(), [`custom:${serviceFieldId}`]: 'spaceships' } },
    });
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('NOT_AN_OPTION');
  });

  it('insists on a consent box the form marked required', async () => {
    const form = await createForm({
      fields: [
        { standardFieldKey: 'phone', label: 'Mobile number', isRequired: true },
        { standardFieldKey: 'consentCalls', label: 'You may call me', isRequired: true },
      ],
    });
    const refused = await api('POST', `/public/forms/${form.publicKey}/submissions`, {
      payload: { answers: { 'standard:phone': freshPhone() } },
    });
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('CONSENT_REQUIRED');
  });

  it('thanks a bot rather than telling it, and records why nothing happened', async () => {
    const form = await createForm();
    const bot = await api<{ received: boolean }>(
      'POST',
      `/public/forms/${form.publicKey}/submissions`,
      {
        payload: { answers: { ...answers(), website_url: 'http://spam.example' } },
      },
    );
    // 201 and a thank-you: the honeypot's whole value is that nothing tells the filler it was
    // caught. A 400 teaches a spam tool to leave the hidden field alone.
    expect(bot.statusCode).toBe(201);
    expect(bot.body.data.received).toBe(true);

    const submissions = await setup<{ status: string; error: string | null; lead: unknown }[]>(
      'GET',
      `/forms/submissions?formId=${form.id}`,
      { token: orgA.token },
    );
    expect(submissions[0]?.status).toBe('rejected');
    expect(submissions[0]?.error).toContain('Honeypot');
    expect(submissions[0]?.lead).toBeNull();
    const counted = await setup<FormBody>('GET', `/forms/${form.id}`, { token: orgA.token });
    expect(counted.submissionCount, 'a bot is not a submission anybody counts').toBe(0);
  });

  it('keeps no address, only a hash of one', async () => {
    const form = await createForm();
    await setup('POST', `/public/forms/${form.publicKey}/submissions`, {
      payload: { answers: answers() },
    });
    const row = await ctx.db.formSubmission.findFirstOrThrow({
      where: { formId: form.id },
      orderBy: { createdAt: 'desc' },
    });
    // The hash is there (it is what the rate limit counts), and it is not an address.
    expect(row.ipHash === null || !row.ipHash.includes('.')).toBe(true);
  });
});

describe('one workspace cannot reach another’s form', () => {
  it('cannot read, edit, rotate or delete it', async () => {
    const form = await createForm();
    expect((await api('GET', `/forms/${form.id}`, { token: orgB.token })).statusCode).toBe(404);
    expect(
      (
        await api('PATCH', `/forms/${form.id}`, {
          token: orgB.token,
          payload: { name: 'Mine now' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await api('POST', `/forms/${form.id}/rotate-key`, { token: orgB.token })).statusCode,
    ).toBe(404);
    expect((await api('DELETE', `/forms/${form.id}`, { token: orgB.token })).statusCode).toBe(404);
  });

  it('cannot see its submissions, or the leads they created', async () => {
    const form = await createForm();
    const phone = freshPhone();
    await setup('POST', `/public/forms/${form.publicKey}/submissions`, {
      payload: { answers: { ...answers(), 'standard:phone': phone } },
    });
    const theirs = await setup<unknown[]>('GET', `/forms/submissions?formId=${form.id}`, {
      token: orgB.token,
    });
    // A list of nothing, not a 404: the honest answer to "show me the submissions on a form I
    // cannot see", and it must not leak that the form exists.
    expect(theirs).toEqual([]);
    const leads = await setup<unknown[]>(
      'GET',
      `/leads?search=${encodeURIComponent(phone.slice(-8))}`,
      {
        token: orgB.token,
      },
    );
    expect(leads).toEqual([]);
  });

  it('captures into the form’s own workspace, whoever is looking', async () => {
    const form = await createForm();
    const phone = freshPhone();
    await setup('POST', `/public/forms/${form.publicKey}/submissions`, {
      payload: { answers: { ...answers(), 'standard:phone': phone } },
    });
    const lead = await ctx.db.lead.findFirstOrThrow({ where: { phoneE164: phone } });
    expect(lead.organizationId).toBe(orgA.organizationId);
    expect(lead.formId).toBe(form.id);
  });
});
