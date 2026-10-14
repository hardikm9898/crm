import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Public } from '../auth/guards/public.decorator.js';
import { zodBody } from '../../infra/http/zod-validation.pipe.js';
import { PublicFormsService } from './public-forms.service.js';
import { submitFormSchema, type SubmitFormInput } from './forms.dto.js';

/**
 * The two endpoints a stranger reaches (`FR-CAP-2`).
 *
 * `@Public()` and declared as such, because a visitor filling in a website form has no session —
 * and declared rather than defaulted, which is why a route that forgets to say so fails at boot.
 *
 * The key in the path is the authentication *and* the tenant resolution: it is random, 32
 * characters, globally unique and rotatable, and `forms_public_key_long_enough` keeps a short one
 * out of the database (ADR-0029). An inactive or deleted form answers 404, exactly as a key that
 * never existed does — a deactivated form must not be distinguishable from a made-up URL.
 *
 * Neither endpoint is a mutation of the product's own state as a reader would see it: `GET` renders
 * and `POST` captures, which is the split the import wizard's dry run paid for.
 */
@Public()
@Controller('public/forms')
export class PublicFormsController {
  constructor(private readonly forms: PublicFormsService) {}

  @Get(':key')
  async definition(@Param('key') key: string) {
    return this.forms.definition(key);
  }

  @Post(':key/submissions')
  @HttpCode(201)
  async submit(@Param('key') key: string, @Body(zodBody(submitFormSchema)) body: unknown) {
    return this.forms.submit(key, body as SubmitFormInput);
  }
}
