import { SetMetadata } from '@nestjs/common';

export const SESSION_ONLY_KEY = 'leados:session-only';

/**
 * Marks a route — or a whole controller — as being about the **signed-in person** rather than
 * about the workspace, so an API key cannot reach it (`FR-API-1`).
 *
 * `/auth/me` is the reason this exists. A key acts as the member who created it, so its principal
 * carries that person's id: without this marker the endpoint would hand a credential that person's
 * profile, their session list, their MFA state and **the other workspaces they belong to** — which
 * is a cross-workspace leak through a credential scoped to one workspace. Nothing in the permission
 * catalogue describes "is a person", because until step 4 every caller was one.
 *
 * Enforced by `PermissionGuard`, which already runs after the principal exists. The
 * `CurrentUser`/`CurrentSession` decorators refuse a key too: this marker covers the routes that
 * read the principal directly instead.
 */
export const SessionOnly = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SESSION_ONLY_KEY, true);
