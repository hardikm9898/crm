import Link from 'next/link';
import { describeError } from '@/lib/api';
import { readAccessToken, requireCurrentUser } from '@/lib/session';
import { Badge, Card, EmptyState, ErrorNotice, PageHeader, StatCard } from '@/components/ui';
import { formatDateTime, formatPhone, relativeTime } from '@/lib/lead-format';
import {
  CONVERSATION_STATUSES,
  STATUS_LABELS,
  conversationQuery,
  conversationTitle,
  loadConversation,
  loadConversations,
  loadMessages,
  messageStanding,
  type ConversationDetail,
  type ConversationMessage,
} from '@/lib/whatsapp';
import { MarkReadForm } from './_components/inbox-forms';

/**
 * The WhatsApp inbox (`FR-WA-7`, `FR-WA-8`).
 *
 * Three decisions are visible on this screen:
 *
 *  * **The open conversation is fetched by id, not found in the list.** `/inbox?c=<id>` is the link
 *    a notification sends somebody, and the filter it lands on may exclude the row — the trap the
 *    task panel paid for, where a deep link into a filtered list silently opened nothing.
 *  * **Every figure is the whole filter's**, aggregated by the API. A badge that counted the
 *    twenty-five rows it loaded would tell an agent their inbox is a fraction of its real size.
 *  * **The 24-hour window is the API's sentence**, not arithmetic repeated here. `FR-WA-1` is
 *    enforced on the write path, and a second implementation on the screen is how "the button was
 *    enabled and the send was refused" happens.
 */
export const dynamic = 'force-dynamic';

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCurrentUser();
  const params = await searchParams;
  const one = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : undefined);
  const token = await readAccessToken();

  const filters = {
    status: one('status'),
    assigned: one('assigned'),
    unread: one('unread'),
    q: one('q'),
  };
  const selected = one('c');

  let page: Awaited<ReturnType<typeof loadConversations>>;
  try {
    page = await loadConversations(conversationQuery(filters), token);
  } catch (error) {
    return (
      <>
        <PageHeader title="Inbox" />
        {/* Never swallowed into an empty state: "no conversations" is itself information here, and
            a loader whose failure is indistinguishable from an empty result is the lie the product
            catalogue paid for. */}
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </>
    );
  }

  // The open conversation, by id. Throwing is right: a link that names a conversation and shows
  // nothing is worse than one that says plainly it cannot be opened.
  let conversation: ConversationDetail | null = null;
  let messages: ConversationMessage[] = [];
  let openError: string | null = null;
  if (selected) {
    try {
      conversation = await loadConversation(selected, token);
      messages = (await loadMessages(selected, token)).items;
    } catch (error) {
      openError = describeError(error);
    }
  }

  const now = new Date();

  return (
    <>
      <PageHeader
        title="Inbox"
        description="What people have sent you on WhatsApp, beside who they are in this workspace."
      />

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard label="Conversations" value={String(page.total)} hint="Over the whole filter." />
        <StatCard label="Unread" value={String(page.unread)} hint="Nobody has answered these." />
        <StatCard label="Open" value={String(page.open)} hint="Not closed." />
      </div>

      <form method="get" action="/inbox" className="mb-4 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Search
          <input
            type="search"
            name="q"
            defaultValue={filters.q ?? ''}
            placeholder="A word they wrote, or their number"
            className="w-64 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text)]"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Status
          <select
            name="status"
            defaultValue={filters.status ?? ''}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text)]"
          >
            <option value="">Any status</option>
            {CONVERSATION_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Whose
          <select
            name="assigned"
            defaultValue={filters.assigned ?? ''}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text)]"
          >
            {/* Absent means everybody's — not "unassigned". Folding the two would hide most of an
                agent's inbox and look like missing messages. */}
            <option value="">Everyone I can see</option>
            <option value="me">Mine</option>
            <option value="unassigned">Nobody’s yet</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Read
          <select
            name="unread"
            defaultValue={filters.unread ?? ''}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text)]"
          >
            <option value="">Either</option>
            <option value="true">Unread only</option>
            <option value="false">Already read</option>
          </select>
        </label>
        <button
          type="submit"
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm"
          data-inbox-filter
        >
          Filter
        </button>
      </form>

      <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
        <Card title="Conversations" description="Newest reply first.">
          {page.items.length === 0 ? (
            <EmptyState
              title="Nothing here yet"
              description="Connect a WhatsApp number in Settings → WhatsApp, then message it from your phone. Whatever arrives shows up here and on the lead it belongs to."
              action={
                <Link href="/settings/whatsapp" className="text-sm text-[var(--color-primary)]">
                  Set up WhatsApp →
                </Link>
              }
            />
          ) : (
            <ul className="flex flex-col divide-y divide-[var(--color-border)]/60">
              {page.items.map((row) => (
                <li key={row.id} data-conversation={row.id}>
                  <Link
                    href={`/inbox?${new URLSearchParams({
                      ...(filters.status ? { status: filters.status } : {}),
                      ...(filters.assigned ? { assigned: filters.assigned } : {}),
                      ...(filters.unread ? { unread: filters.unread } : {}),
                      ...(filters.q ? { q: filters.q } : {}),
                      c: row.id,
                    }).toString()}`}
                    className="flex flex-col gap-1 py-3"
                    aria-current={row.id === selected ? 'page' : undefined}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span
                        className={`text-sm ${row.id === selected ? 'font-semibold' : 'font-medium'}`}
                        data-conversation-title={row.id}
                      >
                        {conversationTitle(row)}
                      </span>
                      {row.unreadCount > 0 && (
                        <span data-conversation-unread={row.id}>
                          <Badge tone="warning">{row.unreadCount} unread</Badge>
                        </span>
                      )}
                    </span>
                    <span
                      className="line-clamp-2 text-xs text-[var(--color-text-muted)]"
                      data-conversation-preview={row.id}
                    >
                      {row.lastMessage
                        ? `${row.lastMessage.direction === 'outbound' ? 'You: ' : ''}${row.lastMessage.preview}`
                        : 'No messages yet'}
                    </span>
                    <span className="text-xs text-[var(--color-text-muted)]">
                      {relativeTime(row.lastMessageAt, now)} · {STATUS_LABELS[row.status]}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="flex flex-col gap-4">
          {openError && <ErrorNotice>{openError}</ErrorNotice>}
          {conversation === null && openError === null && (
            <Card title="Pick a conversation">
              <p className="text-sm text-[var(--color-text-muted)]">
                Choose someone on the left to read what they sent. Everything they say is also on
                their lead’s timeline, so nothing here is the only copy.
              </p>
            </Card>
          )}
          {conversation !== null && (
            <>
              <Thread conversation={conversation} messages={messages} />
              <LeadContext conversation={conversation} />
            </>
          )}
        </div>
      </div>
    </>
  );
}

/** The messages, oldest at the top — which is how a conversation reads. */
function Thread({
  conversation,
  messages,
}: {
  conversation: ConversationDetail;
  messages: ConversationMessage[];
}) {
  const ordered = [...messages].reverse();
  return (
    <Card
      title={conversationTitle(conversation)}
      description={`${formatPhone(conversation.contact)}${
        conversation.number ? ` → ${formatPhone(conversation.number.displayPhoneE164)}` : ''
      }`}
      action={<MarkReadForm conversationId={conversation.id} />}
    >
      {/* The window, as the API phrases it. A business owner reads a sentence; an instant would
          leave them to do the arithmetic. */}
      <p
        className={`mb-3 text-sm ${
          conversation.windowIsOpen
            ? 'text-[var(--color-text-muted)]'
            : 'text-[var(--color-warning)]'
        }`}
        data-window-summary={conversation.id}
      >
        {conversation.windowSummary}
      </p>

      {ordered.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">Nothing in this conversation yet.</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {ordered.map((message) => {
            const standing = messageStanding(message);
            return (
              <li
                key={message.id}
                data-message={message.id}
                className={`max-w-[85%] rounded-[var(--radius-card)] border px-3 py-2 text-sm ${
                  message.direction === 'inbound'
                    ? 'self-start border-[var(--color-border)] bg-[var(--color-surface)]'
                    : 'self-end border-transparent bg-[var(--color-primary)]/10'
                }`}
              >
                <p data-message-body={message.id}>{message.preview}</p>
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  {message.direction === 'inbound'
                    ? 'They sent this'
                    : `${message.sender?.name ?? 'Sent'}`}{' '}
                  · {formatDateTime(message.createdAt)}
                  {standing ? ` · ${standing}` : ''}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

/**
 * `FR-WA-8`: who this person is in the workspace, on the same screen.
 *
 * The point of an inbox inside a CRM rather than beside one: the agent answering a message should
 * not have to go and find out whether this is a lead somebody is already working.
 */
function LeadContext({ conversation }: { conversation: ConversationDetail }) {
  const lead = conversation.lead;
  if (lead === null) {
    return (
      <Card title="Who this is">
        <p className="text-sm text-[var(--color-text-muted)]">
          No lead is attached to this conversation. That happens when the number could not be read
          as a phone number — the messages are kept either way.
        </p>
      </Card>
    );
  }
  return (
    <Card
      title="Who this is"
      action={
        <Link
          href={`/leads/${lead.id}`}
          className="text-sm text-[var(--color-primary)]"
          data-conversation-lead={conversation.id}
        >
          Open the lead →
        </Link>
      }
    >
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Fact label="Name" value={lead.fullName} />
        <Fact label="Status" value={lead.status?.name ?? 'No status'} />
        <Fact label="Score" value={String(lead.score)} />
        <Fact label="Owner" value={lead.owner?.name ?? 'Nobody yet'} />
        <Fact label="Phone" value={formatPhone(lead.phone)} />
        <Fact label="Email" value={lead.email ?? '—'} />
      </dl>
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      {/* Printed as text rather than only as a value: a panel whose facts live in attributes is
          unreadable at a glance and unassertable by a browser check. */}
      <dt className="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">{label}</dt>
      <dd className="mt-0.5" data-fact={label}>
        {value}
      </dd>
    </div>
  );
}
