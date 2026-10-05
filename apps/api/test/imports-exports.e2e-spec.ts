import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newToken } from '@leados/shared';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';
import { ImportRunnerService } from '../src/modules/imports/import-runner.service.js';
import { ExportGeneratorService } from '../src/modules/exports/export-generator.service.js';
import { DocumentsService } from '../src/modules/documents/documents.service.js';

/**
 * THE IMPORT AND EXPORT SUITE.
 *
 * The Phase 2 exit criterion this answers: *"a 5 000-row CSV imports with a mapping the person
 * confirmed, duplicates handled by the tenant's own rules, every row accounted for, and the failed
 * rows downloadable as a file that can be corrected and re-imported."*
 *
 * Two things are deliberately **not** mocked. The import runs through `ImportRunnerService` exactly
 * as the queue would call it (there is no worker in a test, so the test is the worker), which means
 * leads are created through `LeadsService` with the tenant's real duplicate rules — the alternative
 * would prove only that the test's idea of importing works. And storage is the real local driver,
 * so the error file and the export are bytes on a disk that a download has to find.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2eio${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';

const HEADER =
  'Name,Mobile No.,E-mail ID,Company,City,Lead Status,Priority,Budget,Tags,Enquiry Date,Remarks,WhatsApp Opt In';

/**
 * Six data rows, each chosen for one outcome: two importable, one unreadable phone (which also
 * carries a spreadsheet formula, so the error file's guard is exercised), one status this
 * workspace does not have, one blank line, and one repeat of the first phone number.
 */
const CSV = [
  HEADER,
  `Priya Sharma,9876543210,priya.${SUFFIX}@io.test,Sharma Textiles,Surat,New,High,"1,25,000","Follow up; Walk-in",15/03/2026,Wants a quote by Friday,Yes`,
  `Rahul Mehta,9876500011,rahul.${SUFFIX}@io.test,Mehta Steel,Pune,New,medium,45000,Budget confirmed,2026-02-01,,No`,
  `"=cmd|' /C calc'!A0",12,inject.${SUFFIX}@io.test,Formula Co,Mumbai,New,low,1000,,,,`,
  `Unknown Status,9876500013,us.${SUFFIX}@io.test,US Co,Delhi,Site Visit Done,low,100,,,,`,
  ',,,,,,,,,,,',
  `Priya Again,9876543210,priya.again.${SUFFIX}@io.test,Sharma Textiles,Surat,New,high,200000,,,,`,
].join('\n');

let ctx: TestApp;
let orgA: { token: string; organizationId: string; userId: string };
let orgB: { token: string; organizationId: string; userId: string };

async function api<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  options: { token: string; payload?: unknown; headers?: Record<string, string> },
) {
  return call<EnvelopeBody<T>>(ctx.app, {
    method,
    url: `/api/v1${url}`,
    token: options.token,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
    ...(options.headers ? { headers: options.headers } : {}),
  });
}

/** A raw CSV upload: the body is the file, so it cannot go through the JSON helper. */
async function upload(csv: string, fileName = 'leads.csv', token = orgA.token) {
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/imports?fileName=${encodeURIComponent(fileName)}`,
    payload: csv,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'text/csv' },
  });
  return { statusCode: response.statusCode, body: response.json() as EnvelopeBody<never> };
}

/** A setup call whose refusal must not be silent (the trap from the duplicates suite). */
async function configure<T = unknown>(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
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

async function createTenant(label: string) {
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
      name: `Owner ${label}`,
      organizationName: `IO ${label} ${SUFFIX}`,
    },
  });
  return {
    token: registered.body.data.tokens.accessToken,
    organizationId: registered.body.data.activeOrganizationId,
    userId: registered.body.data.user.id,
  };
}

/** Maps the file, then runs it the way the queue would. */
async function runImport(mode: string, csv = CSV, fileName = 'leads.csv') {
  const uploaded = await upload(csv, fileName);
  expect(uploaded.statusCode, JSON.stringify(uploaded.body)).toBe(201);
  const id = (uploaded.body.data as { id: string; mapping: Record<string, string> }).id;
  const mapping = (uploaded.body.data as { mapping: Record<string, string> }).mapping;
  await configure('PUT', `/imports/${id}/mapping`, {
    token: orgA.token,
    payload: { mapping, mode },
  });
  await configure('POST', `/imports/${id}/start`, { token: orgA.token });
  await ctx.app.get(ImportRunnerService).run(orgA.organizationId, id);
  const job = await api<ImportSummary>('GET', `/imports/${id}`, { token: orgA.token });
  return { id, mapping, job: job.body.data };
}

interface ImportSummary {
  status: string;
  mode: string;
  hasErrorFile: boolean;
  error: string | null;
  totals: {
    rows: number;
    processed: number;
    created: number;
    updated: number;
    attached: number;
    skipped: number;
    failed: number;
  };
}

beforeAll(async () => {
  ctx = await bootTestApp();
  orgA = await createTenant('orga');
  orgB = await createTenant('orgb');
}, 120_000);

afterAll(async () => {
  await cleanupUsers(ctx.db, EMAIL_MARKER);
  await ctx.close();
});

describe('the wizard reads a file people would actually upload', () => {
  it('proposes a mapping for headings nobody should have to hand-map', async () => {
    const uploaded = await upload(CSV);
    expect(uploaded.statusCode).toBe(201);
    const data = uploaded.body.data as {
      totalRows: number;
      mapping: Record<string, string>;
      unmatched: string[];
      sample: Record<string, string>[];
    };

    expect(data.totalRows).toBe(6);
    expect(data.mapping['Mobile No.']).toBe('phone');
    expect(data.mapping['E-mail ID']).toBe('email');
    expect(data.mapping['Lead Status']).toBe('statusId');
    expect(data.mapping['Budget']).toBe('value');
    expect(data.mapping['Enquiry Date']).toBe('createdAt');
    expect(data.mapping['Remarks']).toBe('notes');
    expect(data.mapping['WhatsApp Opt In']).toBe('consentWhatsapp');
    expect(data.unmatched).toEqual([]);
    expect(data.sample[0]?.['Name']).toBe('Priya Sharma');
  });

  it('counts the blank row, because dropping it would renumber every row after it', async () => {
    const uploaded = await upload(CSV);
    const data = uploaded.body.data as { totalRows: number };
    // Six physical rows, one of which is nothing but separators. The importer decides it is blank;
    // the parser does not get to quietly remove it and shift row 7 up to row 6.
    expect(data.totalRows).toBe(6);
  });

  it('refuses a file with no rows, and one with no headings', async () => {
    const noRows = await upload('Name,Phone\n');
    expect(noRows.statusCode).toBe(400);
    expect(JSON.stringify(noRows.body)).toContain('NO_ROWS');

    const empty = await upload('   ');
    expect(empty.statusCode).toBe(400);
    expect(JSON.stringify(empty.body)).toContain('EMPTY_FILE');
  });

  it('sniffs a semicolon-separated file, which is what a European Excel exports', async () => {
    const uploaded = await upload('Name;Mobile No.;E-mail ID\nAnita;9876500099;anita@io.test\n');
    const data = uploaded.body.data as { delimiter: string; mapping: Record<string, string> };
    expect(data.delimiter).toBe(';');
    expect(data.mapping['Mobile No.']).toBe('phone');
  });

  it('refuses a mapping with no way to identify a person', async () => {
    const uploaded = await upload(CSV);
    const id = (uploaded.body.data as { id: string }).id;
    const refused = await api('PUT', `/imports/${id}/mapping`, {
      token: orgA.token,
      payload: { mapping: { Name: 'fullName', Company: 'company' }, mode: 'create_only' },
    });
    expect(refused.statusCode).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('NO_IDENTIFIER');
  });

  it('refuses two columns mapped to the same field', async () => {
    const uploaded = await upload(CSV);
    const data = uploaded.body.data as { id: string; mapping: Record<string, string> };
    const refused = await api('PUT', `/imports/${data.id}/mapping`, {
      token: orgA.token,
      payload: { mapping: { ...data.mapping, Company: 'phone' }, mode: 'create_only' },
    });
    expect(refused.statusCode).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('DUPLICATE_TARGET');
  });
});

describe('the dry run tells a person what will happen before it happens', () => {
  it('counts what is importable and explains what is not, in human words', async () => {
    const uploaded = await upload(CSV);
    const data = uploaded.body.data as { id: string; mapping: Record<string, string> };
    await configure('PUT', `/imports/${data.id}/mapping`, {
      token: orgA.token,
      payload: { mapping: data.mapping, mode: 'create_only' },
    });

    const dry = await api<{
      valid: number;
      invalid: number;
      blank: number;
      problems: { row: number; errors: { field: string; message: string }[] }[];
      warnings: string[];
    }>('POST', `/imports/${data.id}/validate`, { token: orgA.token });

    expect(dry.body.data.valid).toBe(3);
    expect(dry.body.data.invalid).toBe(2);
    expect(dry.body.data.blank).toBe(1);

    const problems = JSON.stringify(dry.body.data.problems);
    // Zod's own wording ("Too small: expected string to have >=4 characters") reached users once.
    expect(problems).not.toMatch(/Too small|expected string/);
    // The mapper, not the lead schema, is what catches this: `createLeadSchema` only knows the cell
    // is 4–32 characters, so before the mapper normalized it the dry run called this row importable
    // and the run then failed it. The message quotes the cell so the person can find it.
    expect(problems).toContain('is not a phone number we can read');
    expect(problems).toContain('“12”');
    // An unknown status names the ones that exist, which is what makes the failure fixable.
    expect(problems).toContain('does not match any status');
    expect(problems).toContain('New');
    // The row numbers are the ones the person's own spreadsheet shows.
    expect(dry.body.data.problems.map((p) => p.row)).toEqual([4, 5]);
    expect(JSON.stringify(dry.body.data.warnings)).toContain('duplicate rules');
  });
});

describe('a run in create_only mode applies the tenant’s duplicate rules (FR-IO-2)', () => {
  let result: Awaited<ReturnType<typeof runImport>>;

  beforeAll(async () => {
    result = await runImport('create_only');
  }, 60_000);

  it('finishes with every row accounted for', () => {
    expect(result.job.status).toBe('completed');
    expect(result.job.totals).toMatchObject({
      rows: 6,
      processed: 6,
      created: 2,
      attached: 1,
      skipped: 1,
      failed: 2,
      updated: 0,
    });
  });

  it('attaches the repeat phone number instead of creating a second lead', async () => {
    const rows = await api<{ rowNumber: number; status: string; leadId: string | null }[]>(
      'GET',
      `/imports/${result.id}/rows`,
      { token: orgA.token },
    );
    const byNumber = new Map(rows.body.data.map((row) => [row.rowNumber, row]));
    expect(byNumber.get(2)?.status).toBe('created');
    expect(byNumber.get(7)?.status).toBe('attached');
    // The same lead, reached twice — which is the whole point of `attach_to_existing`.
    expect(byNumber.get(7)?.leadId).toBe(byNumber.get(2)?.leadId);
    expect(byNumber.get(6)?.status).toBe('skipped');
    expect(byNumber.get(4)?.status).toBe('failed');
  });

  it('records the cells as they arrived, so a row is answerable later', async () => {
    const rows = await api<{ rowNumber: number; raw: Record<string, string> }[]>(
      'GET',
      `/imports/${result.id}/rows?status=created`,
      { token: orgA.token },
    );
    expect(rows.body.data[0]?.raw['Mobile No.']).toBe('9876543210');
  });

  it('produces a lead indistinguishable from a manually created one', async () => {
    const rows = await api<{ leadId: string }[]>(
      'GET',
      `/imports/${result.id}/rows?status=created`,
      {
        token: orgA.token,
      },
    );
    const leadId = rows.body.data[0]?.leadId;
    const lead = await api<{
      firstName: string;
      lastName: string;
      phone: string;
      valueMinor: number;
      createdAt: string;
      consent: { whatsapp: boolean };
      tags: { name: string }[];
      status: { name: string };
    }>('GET', `/leads/${leadId}`, { token: orgA.token });

    expect(lead.body.data.firstName).toBe('Priya');
    expect(lead.body.data.lastName).toBe('Sharma');
    expect(lead.body.data.phone).toBe('+919876543210');
    // `1,25,000` is 125 000 rupees, which is 12 500 000 paise.
    expect(lead.body.data.valueMinor).toBe(12_500_000);
    expect(lead.body.data.createdAt.startsWith('2026-03-15')).toBe(true);
    expect(lead.body.data.consent.whatsapp).toBe(true);
    expect(lead.body.data.status.name).toBe('New');
    expect(lead.body.data.tags.map((tag) => tag.name).sort()).toEqual(['Follow up', 'Walk-in']);
  });

  it('puts an imported remark on the timeline rather than inventing a column', async () => {
    const rows = await api<{ leadId: string }[]>(
      'GET',
      `/imports/${result.id}/rows?status=created`,
      {
        token: orgA.token,
      },
    );
    const timeline = await api<{ type: string; payload: Record<string, unknown> }[]>(
      'GET',
      `/leads/${rows.body.data[0]?.leadId}/timeline`,
      { token: orgA.token },
    );
    const note = timeline.body.data.find((entry) => entry.type === 'note.added');
    expect(note?.payload['note']).toBe('Wants a quote by Friday');
    expect(note?.payload['via']).toBe('import');
  });

  it('writes an error file that reproduces the rows and neutralises a formula', async () => {
    expect(result.job.hasErrorFile).toBe(true);
    const file = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/imports/${result.id}/errors.csv`,
      headers: { authorization: `Bearer ${orgA.token}` },
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-disposition']).toContain('attachment');
    // A CSV that a browser decides is HTML is a stored cross-site scripting vector.
    expect(file.headers['x-content-type-options']).toBe('nosniff');

    const text = file.body;
    expect(text).toContain('_row');
    expect(text).toContain('Mobile No.');
    expect(text).toContain('is not a phone number we can read');
    // Guarded with a tab rather than dropped: `unguardCell` reverses it exactly, so the corrected
    // file can be re-imported without the guard becoming part of somebody's data.
    expect(text).toContain(`"\t=cmd|' /C calc'!A0"`);
  });

  it('is idempotent: running the same job again changes nothing', async () => {
    await ctx.app.get(ImportRunnerService).run(orgA.organizationId, result.id);
    const again = await api<ImportSummary>('GET', `/imports/${result.id}`, { token: orgA.token });
    expect(again.body.data.totals).toMatchObject(result.job.totals);
  });

  it('keeps another tenant out of the job, its rows and its error file', async () => {
    expect((await api('GET', `/imports/${result.id}`, { token: orgB.token })).statusCode).toBe(404);
    expect((await api('GET', `/imports/${result.id}/rows`, { token: orgB.token })).statusCode).toBe(
      404,
    );
    const file = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/imports/${result.id}/errors.csv`,
      headers: { authorization: `Bearer ${orgB.token}` },
    });
    expect(file.statusCode).toBe(404);
  });
});

describe('the other two modes mean what they say', () => {
  it('skip_existing creates nothing and does not attach either', async () => {
    const result = await runImport('skip_existing', CSV, 'leads-again.csv');
    expect(result.job.totals.created).toBe(0);
    expect(result.job.totals.updated).toBe(0);
    // Detection happens before the lead service is reached, so the tenant's `attach_to_existing`
    // rule never gets the chance to overrule the mode the person chose.
    expect(result.job.totals.attached).toBe(0);
    expect(result.job.totals.skipped).toBe(4);
    expect(result.job.totals.failed).toBe(2);
  }, 60_000);

  it('update_existing corrects the leads it matches', async () => {
    const edited = CSV.replaceAll('Sharma Textiles,Surat', 'Sharma Textiles Ltd,Ahmedabad');
    const result = await runImport('update_existing', edited, 'leads-corrected.csv');
    expect(result.job.totals.updated).toBe(3);
    expect(result.job.totals.created).toBe(0);

    const search = await api<{ id: string; city: string; company: string; tags: unknown[] }[]>(
      'GET',
      '/leads?search=Sharma',
      { token: orgA.token },
    );
    const priya = search.body.data.find((lead) => lead.company === 'Sharma Textiles Ltd');
    expect(priya?.city).toBe('Ahmedabad');
    // A re-upload mentioning one tag must not strip the ones somebody added by hand.
    expect(priya?.tags).toHaveLength(2);
  }, 60_000);

  it('a cancelled job is not processed, and the leads already imported are kept', async () => {
    const uploaded = await upload(CSV, 'leads-cancelled.csv');
    const data = uploaded.body.data as { id: string; mapping: Record<string, string> };
    await configure('PUT', `/imports/${data.id}/mapping`, {
      token: orgA.token,
      payload: { mapping: data.mapping, mode: 'create_only' },
    });
    await configure('POST', `/imports/${data.id}/start`, { token: orgA.token });
    await configure('POST', `/imports/${data.id}/cancel`, { token: orgA.token });

    await ctx.app.get(ImportRunnerService).run(orgA.organizationId, data.id);
    const job = await api<ImportSummary>('GET', `/imports/${data.id}`, { token: orgA.token });
    expect(job.body.data.status).toBe('cancelled');
    expect(job.body.data.totals.processed).toBe(0);
  }, 60_000);
});

describe('exports are a job, a permission and an expiring file (FR-IO-3)', () => {
  it('refuses an export that says nothing about what to export', async () => {
    const refused = await api('POST', '/exports', {
      token: orgA.token,
      payload: { columns: ['fullName'] },
    });
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('FILTER_REQUIRED');
  });

  it('refuses a column this workspace does not have, by name', async () => {
    const refused = await api('POST', '/exports', {
      token: orgA.token,
      payload: { filter: { conditions: [] }, columns: ['fullName', 'secretSauce'] },
    });
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('secretSauce');
  });

  it('generates a file a person can open in Excel', async () => {
    const created = await configure<{ id: string; includesPii: boolean }>('POST', '/exports', {
      token: orgA.token,
      payload: {
        filter: { conditions: [] },
        columns: ['fullName', 'company', 'phone', 'status', 'owner', 'tags', 'value', 'createdAt'],
      },
    });
    expect(created.body.data.includesPii).toBe(true);

    await ctx.app.get(ExportGeneratorService).run(orgA.organizationId, created.body.data.id);
    const job = await api<{ status: string; rowCount: number; expiresAt: string }>(
      'GET',
      `/exports/${created.body.data.id}`,
      { token: orgA.token },
    );
    expect(job.body.data.status).toBe('completed');
    expect(job.body.data.rowCount).toBe(2);
    expect(job.body.data.expiresAt).toBeTruthy();

    const download = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/exports/${created.body.data.id}/download`,
      headers: { authorization: `Bearer ${orgA.token}` },
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-disposition']).toContain('attachment');
    const text = download.rawPayload.toString('utf8');
    // The BOM and CRLF are what make Excel read it as UTF-8 and keep the rows intact.
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('\r\n');
    // Labels and names, not column names and uuids: an export is a document, not a dump.
    expect(text).toContain('Full name,Company,Phone,Status,Owner,Tags,Deal value,Captured on');
    expect(text).toContain('Sharma Textiles Ltd');
    expect(text).toMatch(/"Follow up, Walk-in"|"Walk-in, Follow up"/);
    // A whole amount, matching what the import's own value column accepts.
    expect(text).toContain('200000.00');
  }, 60_000);

  it('keeps another tenant out of the job and the file', async () => {
    const created = await configure<{ id: string }>('POST', '/exports', {
      token: orgA.token,
      payload: { filter: { conditions: [] }, columns: ['company'] },
    });
    await ctx.app.get(ExportGeneratorService).run(orgA.organizationId, created.body.data.id);

    expect(
      (await api('GET', `/exports/${created.body.data.id}`, { token: orgB.token })).statusCode,
    ).toBe(404);
    const download = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/exports/${created.body.data.id}/download`,
      headers: { authorization: `Bearer ${orgB.token}` },
    });
    expect(download.statusCode).toBe(404);
  }, 60_000);

  it('stops serving a file once it has expired, and the sweep drops the bytes', async () => {
    const created = await configure<{ id: string }>('POST', '/exports', {
      token: orgA.token,
      payload: { filter: { conditions: [] }, columns: ['company', 'status'] },
    });
    await ctx.app.get(ExportGeneratorService).run(orgA.organizationId, created.body.data.id);

    const job = await ctx.db.exportJob.findFirstOrThrow({
      where: { id: created.body.data.id },
      select: { documentId: true },
    });
    // Backdating is the only honest way to test an expiry without waiting three days for one.
    await ctx.db.document.update({
      where: { id: job.documentId! },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const expired = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/exports/${created.body.data.id}/download`,
      headers: { authorization: `Bearer ${orgA.token}` },
    });
    // 410, not 404: the file existed, and "expired" is the one thing the person needs to be told.
    expect(expired.statusCode).toBe(410);

    const swept = await ctx.app.get(DocumentsService).sweepExpired();
    expect(swept.discarded).toBeGreaterThan(0);
    const row = await ctx.db.document.findFirstOrThrow({
      where: { id: job.documentId! },
      select: { deletedAt: true },
    });
    // The row stays: who exported what is audit history, and deleting the evidence with the file
    // would defeat the point of recording it.
    expect(row.deletedAt).not.toBeNull();
  }, 60_000);
});

describe('personal data in an export is its own permission', () => {
  it('refuses the columns, not the export, when export:pii is missing', async () => {
    const role = await configure<{ id: string }>('POST', '/roles', {
      token: orgA.token,
      payload: {
        code: `exporter_${SUFFIX}`,
        name: 'Exporter without personal data',
        grants: [
          { permission: 'lead:read', scope: 'organization' },
          { permission: 'export:data', scope: 'organization' },
          { permission: 'organization:read', scope: 'organization' },
          // Kept so the workspace is not left with nobody who can manage roles, which the API
          // rightly refuses. The point of this role is that it lacks `export:pii`.
          { permission: 'role:manage', scope: 'organization' },
          { permission: 'user:manage', scope: 'organization' },
        ],
      },
    });
    await configure('PUT', `/users/${orgA.userId}/roles`, {
      token: orgA.token,
      payload: { roleIds: [role.body.data.id] },
    });

    const refused = await api('POST', '/exports', {
      token: orgA.token,
      payload: { filter: { conditions: [] }, columns: ['fullName', 'phone'] },
    });
    expect(refused.statusCode).toBe(403);
    // The refusal names the columns, so the person can export the rest rather than guess.
    expect(JSON.stringify(refused.body)).toContain('Phone');

    const allowed = await api('POST', '/exports', {
      token: orgA.token,
      payload: { filter: { conditions: [] }, columns: ['company', 'status', 'value'] },
    });
    expect(allowed.statusCode).toBe(201);
  }, 60_000);
});
