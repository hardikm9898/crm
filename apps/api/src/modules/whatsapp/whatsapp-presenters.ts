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
  /**
   * The attachment, which Prisma hands over as an **array** because the constraint that makes it
   * at-most-one is a unique index rather than anything the schema can express.
   */
  media?: readonly MediaRow[];
}

/** The columns an attachment presenter reads. */
export interface MediaRow {
  id: string;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  downloadStatus: string;
  reason: string | null;
  voice: boolean;
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
    /**
     * The file, when there is one (`FR-WA-3`).
     *
     * `available` rather than leaving the screen to read the status: "there is a photo and we have
     * not got it yet" and "there is a photo and it was refused" are two different sentences, and a
     * thread that rendered an `<img>` for either would show a broken image with no explanation.
     * The bytes themselves are at `GET …/messages/:id/media`; this says whether asking is worth it.
     */
    media: presentMedia(row.media?.[0]),
  };
}

function presentMedia(row: MediaRow | undefined) {
  if (row === undefined) return null;
  return {
    id: row.id,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    downloadStatus: row.downloadStatus,
    /** Why it is not here, when it is not — the sentence a screen prints rather than paraphrases. */
    reason: row.reason,
    /** A voice note is a different thing from an audio file somebody attached. */
    voice: row.voice,
    available: row.downloadStatus === 'stored',
  };
}
