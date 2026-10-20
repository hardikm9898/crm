import Link from 'next/link';
import { describeError } from '@/lib/api';
import { readAccessToken, requireCurrentUser } from '@/lib/session';
import { Card, EmptyState, ErrorNotice, PageHeader, StatCard } from '@/components/ui';
import { loadCannedRepliesOrThrow, type CannedReply } from '@/lib/whatsapp';
import { NewReplyForm, ReplyRow } from './_components/reply-forms';

/**
 * Canned replies (`FR-WA-7`).
 *
 * The shorthand an agent types instead of retyping the same sentence twenty times a day. Three
 * decisions are visible here:
 *
 *  * **A shortcut is cleaned, not demanded.** You type `Price list`; it becomes `/price-list`.
 *  * **"Sent" is the count, not "clicked".** The picker is ordered by it, and a count of clicks
 *    would promote whatever is easiest to misclick.
 *  * **Removing takes it out of the picker, and keeps the row.** A reply that has been sent has
 *    messages pointing at it, so deleting it would either fail or take the history with it.
 *
 * Read through the **throwing** loader: on a screen whose whole job is to list replies, "none" is
 * information somebody acts on, and a swallowed failure would tell a workspace with twenty replies
 * to write its first.
 */
export const metadata = { title: 'Canned replies · Lead OS' };

export default async function CannedRepliesPage() {
  await requireCurrentUser();
  const token = await readAccessToken();

  let replies: CannedReply[];
  try {
    replies = await loadCannedRepliesOrThrow(token);
  } catch (error) {
    return (
      <>
        <PageHeader title="Canned replies" />
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </>
    );
  }

  const shared = replies.filter((reply) => reply.visibility === 'shared');
  const sent = replies.reduce((total, reply) => total + reply.usageCount, 0);

  return (
    <>
      <PageHeader
        title="Canned replies"
        description="Shortcuts your team types in the composer instead of retyping the same sentence."
        action={
          <Link href="/settings/whatsapp/templates" className="text-sm underline">
            Templates
          </Link>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard label="Replies" value={String(replies.length)} hint="Shared and your own." />
        <StatCard label="Shared" value={String(shared.length)} hint="Anybody here can use these." />
        <StatCard
          label="Times sent"
          value={String(sent)}
          hint="What orders the picker — sends, not clicks."
        />
      </div>

      <Card
        title="Add a reply"
        description="Type the shortcut as words; the slash and the hyphens are added for you."
      >
        <NewReplyForm />
      </Card>

      <Card
        title="Your replies"
        description="Most-used first, which is the order the composer offers them in."
      >
        {replies.length === 0 ? (
          <EmptyState
            title="No canned replies yet"
            description="Add the sentence you type most often — a price list, a site-visit offer, a thank you."
          />
        ) : (
          <ol className="flex flex-col gap-2">
            {replies.map((reply) => (
              <ReplyRow key={reply.id} reply={reply} />
            ))}
          </ol>
        )}
      </Card>
    </>
  );
}
