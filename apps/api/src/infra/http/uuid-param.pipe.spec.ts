import { describe, expect, it } from 'vitest';
import type { ArgumentMetadata } from '@nestjs/common';
import { AppError } from '@leados/shared';
import { UuidParamPipe } from './uuid-param.pipe.js';

const pipe = new UuidParamPipe();
const param = (data: string): ArgumentMetadata => ({ type: 'param', data });
const VALID = '01a10f8a-5990-70fd-b9ef-2039c91dc02d';

describe('a path parameter that is not a UUID', () => {
  it('passes a well-formed id through unchanged', () => {
    expect(pipe.transform(VALID, param('id'))).toBe(VALID);
  });

  it('answers 404 rather than letting Prisma raise a 500', () => {
    // This is the whole point: `GET /leads/not-a-uuid` used to reach the database and come back as
    // an internal error, filling the log with 500s for requests that were merely wrong.
    expect(() => pipe.transform('not-a-uuid', param('id'))).toThrow(AppError);
    try {
      pipe.transform('not-a-uuid', param('id'));
    } catch (error) {
      expect((error as AppError).status).toBe(404);
    }
  });

  it('refuses a UUID-shaped string that is not one', () => {
    expect(() => pipe.transform(`${VALID}x`, param('id'))).toThrow(AppError);
    expect(() => pipe.transform(VALID.replace('-', ''), param('id'))).toThrow(AppError);
    expect(() => pipe.transform('', param('id'))).toThrow(AppError);
  });

  it('checks any parameter whose name ends in Id', () => {
    expect(() => pipe.transform('nope', param('userId'))).toThrow(AppError);
    expect(pipe.transform(VALID, param('userId'))).toBe(VALID);
  });

  it('leaves a parameter that is not an id alone', () => {
    // A future `:slug` or `:provider` must not be forced into a UUID.
    expect(pipe.transform('acme-realty', param('slug'))).toBe('acme-realty');
    expect(pipe.transform('whatsapp', param('provider'))).toBe('whatsapp');
  });

  it('leaves bodies and query strings to their own schemas', () => {
    expect(pipe.transform('anything', { type: 'body', data: 'id' })).toBe('anything');
    expect(pipe.transform('anything', { type: 'query', data: 'id' })).toBe('anything');
  });
});
