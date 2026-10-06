import { describeError, request } from '@/lib/api';
import { can, readAccessToken, requireCurrentUser } from '@/lib/session';
import { onboardingProgress, type OnboardingState } from '@/lib/onboarding';
import { Badge, Card, DefinitionRow, ErrorNotice, PageHeader } from '@/components/ui';
import { OrganizationForm } from './organization-form';
import { OnboardingWizard } from './onboarding-wizard';
import { IndustryPicker } from './industry-picker';
import { loadIndustryTemplates, type IndustryTemplateOption } from '@/lib/industry-templates';

/** Workspace settings: the profile that shapes every other screen, plus the setup wizard. */
interface OrganizationDetail {
  id: string;
  slug: string;
  name: string;
  legalName: string | null;
  industry: string | null;
  country: string | null;
  timezone: string;
  defaultCurrency: string;
  defaultPhoneCountry: string;
  logoUrl: string | null;
  status: string;
  publicKey: string;
  onboarding: OnboardingState | null;
  counts: { branches: number; teams: number; activeMembers: number };
  subscription: {
    status: string;
    planCode: string;
    planName: string;
    trialEndsAt: string | null;
    currentPeriodEnd: string | null;
  } | null;
  createdAt: string;
}

export default async function SettingsPage() {
  const user = await requireCurrentUser();
  const token = await readAccessToken();

  let organization: OrganizationDetail | null = null;
  let error: string | null = null;
  try {
    const response = await request<OrganizationDetail>('/organization', { token });
    organization = response.data;
  } catch (failure) {
    error = describeError(failure);
  }

  const editable = can(user, 'organization:manage');

  /**
   * `null` means the request failed, which the card reports — as opposed to `[]`, which would mean
   * the catalogue is genuinely empty. A loader whose failure is indistinguishable from an empty
   * result is the mistake the product catalogue shipped with.
   */
  let templates: IndustryTemplateOption[] | null = null;
  if (editable) {
    templates = await loadIndustryTemplates(token).catch(() => null);
  }

  return (
    <>
      <PageHeader
        title="Organization"
        description="The workspace profile. Timezone and currency are applied everywhere — reports, reminders and message scheduling all read them from here."
        action={organization ? <Badge>{organization.status}</Badge> : undefined}
      />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      {organization && (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="flex flex-col gap-5">
            <Card
              title="Profile"
              description={editable ? undefined : 'You can see these settings but not change them.'}
            >
              <OrganizationForm
                editable={editable}
                organization={{
                  name: organization.name,
                  legalName: organization.legalName,
                  industry: organization.industry,
                  timezone: organization.timezone,
                  defaultCurrency: organization.defaultCurrency,
                  defaultPhoneCountry: organization.defaultPhoneCountry,
                }}
              />
            </Card>

            {editable && (
              <Card
                title="Finish setting up"
                description="Each step is recorded, so you can leave and come back."
              >
                <OnboardingWizard state={organization.onboarding} />
              </Card>
            )}

            {editable && (
              <Card
                title="Your industry"
                description="A template sets up the words your trade uses. Everything it writes stays editable."
              >
                {templates === null ? (
                  <ErrorNotice>
                    The industry templates could not be loaded. Nothing here is required — set your
                    statuses, stages and fields up in Settings instead.
                  </ErrorNotice>
                ) : (
                  <IndustryPicker templates={templates} />
                )}
              </Card>
            )}
          </div>

          <div className="flex flex-col gap-5">
            <Card title="Plan">
              <dl className="divide-y divide-[var(--color-border)]">
                <DefinitionRow label="Plan">
                  {organization.subscription?.planName ?? 'None'}
                </DefinitionRow>
                <DefinitionRow label="Status">
                  {organization.subscription?.status ?? '—'}
                </DefinitionRow>
                <DefinitionRow label="Trial ends">
                  {formatDate(organization.subscription?.trialEndsAt)}
                </DefinitionRow>
                <DefinitionRow label="Renews">
                  {formatDate(organization.subscription?.currentPeriodEnd)}
                </DefinitionRow>
              </dl>
            </Card>

            <Card title="Workspace">
              <dl className="divide-y divide-[var(--color-border)]">
                <DefinitionRow label="Slug">
                  <code className="text-xs">{organization.slug}</code>
                </DefinitionRow>
                <DefinitionRow label="Branches">{organization.counts.branches}</DefinitionRow>
                <DefinitionRow label="Teams">{organization.counts.teams}</DefinitionRow>
                <DefinitionRow label="People">{organization.counts.activeMembers}</DefinitionRow>
                <DefinitionRow label="Created">{formatDate(organization.createdAt)}</DefinitionRow>
              </dl>
            </Card>

            {/*
             * The ingestion key is not a secret — it only identifies the workspace to a website
             * form — but it is what a form posts leads with, so it is shown to administrators
             * rather than to everyone who can read the organization's profile. Every role holds
             * `organization:read` (a sales executive needs the timezone and currency), which makes
             * that the wrong gate for this one card.
             */}
            {editable && (
              <Card
                title="Public key"
                description="Identifies this workspace when a website form posts a lead."
              >
                <code className="block break-all rounded-md bg-[var(--color-surface-muted)] px-2 py-1.5 text-xs">
                  {organization.publicKey}
                </code>
              </Card>
            )}

            <Card title="Setup progress">
              <ul className="flex flex-col gap-2 text-sm">
                {onboardingProgress(organization.onboarding).map(({ step, status }) => (
                  <li key={step.key} className="flex items-center justify-between gap-3">
                    <span
                      className={status === 'done' ? 'text-[var(--color-text-muted)]' : undefined}
                    >
                      {step.label}
                    </span>
                    {status === 'done' ? (
                      <Badge tone="success">Done</Badge>
                    ) : status === 'current' ? (
                      <Badge tone="warning">Next</Badge>
                    ) : (
                      <Badge>To do</Badge>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Dates are formatted in the *organization's* timezone in later phases; until the formatting helper
 * lands with the CRM screens, the date alone avoids implying a precision this page does not have.
 */
function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
