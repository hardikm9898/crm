import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';
import { ApiLogService } from './api-log.service.js';
import { installApiLogging } from './api-log.hook.js';

/**
 * Registers the request-log response hook as part of the **application**, on bootstrap.
 *
 * It was installed from `main.ts` first, which looked right and was not: the e2e harness builds its
 * own application from the same modules, so the suite that exists to prove requests are logged
 * recorded nothing while the running product recorded everything — the feature would have looked
 * built and been untested. Anything that has to be true of every application built from these
 * modules belongs in the modules.
 *
 * A worker or scheduler has no HTTP adapter, so there is nothing to install and nothing to warn
 * about: those processes answer no requests.
 */
@Injectable()
export class ApiLogHookInstaller implements OnApplicationBootstrap {
  constructor(
    private readonly adapters: HttpAdapterHost,
    private readonly logs: ApiLogService,
  ) {}

  onApplicationBootstrap(): void {
    const instance = this.adapters.httpAdapter?.getInstance<FastifyInstance>();
    // `addHook` is only available before the instance is ready, which `onApplicationBootstrap`
    // always is: Nest runs it inside `app.init()`, and Fastify's `ready()` comes after.
    if (typeof instance?.addHook === 'function') installApiLogging(instance, this.logs);
  }
}
