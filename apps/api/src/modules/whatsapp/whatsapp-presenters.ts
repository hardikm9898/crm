import { describeMessagePreview, type MessageType } from '@leados/shared';

/** The columns every message presenter reads. */
export interface MessageRow {
  id: string;
  conversationId: string;
  direction: string;
  type: string;
  body: string | null;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  providerMessageId: string | null;
  replyToProviderId: string | null;
  templateId: string | null;
  sendAttempts: number;
  payload: unknown;
  createdAt: Date;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  failedAt: Date | null;
  sender: { userId: string; user: { name: string } } | null;
}

/**
 * One message, as every screen reads it.
 *
 * **One** presenter, in its own module, because there were briefly two: the thread's list and the
 * send path's answer, and the second carried `sendAttempts` while the first did not — so "tried
 * twice" was true in the database, true in the send's own response, and absent from the list the
 * screen actually renders. A row with two presenters is a row whose two readings diverge; found by
 * asserting the HTTP list rather than the row.
 *
 * In its own file rather than on either service, because both import it and an import between two
 * Nest services is the ESM cycle that is a `ReferenceError` at boot.
 */
export function presentMessage(row: MessageRow) {
  return {
    id: row.id,
    conversationId: row.conversationId,
    direction: row.direction,
    type: row.type,
    body: row.body,
    /** The body, or the sentence that stands in for media — never a placeholder like `[image]`. */
    preview: describeMessagePreview(row.type as MessageType, row.body),
    status: row.status,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    providerMessageId: row.providerMessageId,
    replyToProviderId: row.replyToProviderId,
    templateId: row.templateId,
    /** How many times it has been handed to Meta: what makes a retry visible rather than quiet. */
    sendAttempts: row.sendAttempts,
    sender: row.sender ? { id: row.sender.userId, name: row.sender.user.name } : null,
    payload: row.payload,
    createdAt: row.createdAt,
    sentAt: row.sentAt,
    deliveredAt: row.deliveredAt,
    readAt: row.readAt,
    failedAt: row.failedAt,
  };
}
