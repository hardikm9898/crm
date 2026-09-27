import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request metadata that is not tenant state: the request id used to correlate
 * logs, traces and audit entries (NFR-OBS-1). Tenant identity lives in
 * `tenantContext` from @leados/shared, kept separate so that a request can exist
 * before it is authenticated.
 */
export interface RequestMetadata {
  readonly requestId: string;
  readonly method: string;
  readonly path: string;
  readonly ip?: string;
  readonly userAgent?: string;
  readonly startedAt: number;
}

const storage = new AsyncLocalStorage<RequestMetadata>();

export const requestStore = {
  run<T>(metadata: RequestMetadata, fn: () => Promise<T>): Promise<T> {
    return storage.run(metadata, fn);
  },
  get(): RequestMetadata | undefined {
    return storage.getStore();
  },
  requestId(): string | undefined {
    return storage.getStore()?.requestId;
  },
};
