import { hash, verify, Algorithm } from '@node-rs/argon2';
import { Injectable } from '@nestjs/common';
import { AppError } from '@leados/shared';

/**
 * Password hashing and policy (docs/security.md §2).
 *
 * Argon2id with parameters tuned to roughly 250 ms on a server-class CPU: slow enough to
 * make offline cracking expensive, fast enough that login stays responsive and a login
 * flood cannot exhaust CPU.
 *
 * Policy choices are deliberate:
 *  • length floor, not composition puzzles ("must contain a symbol" produces Passw0rd!)
 *  • rejects the passwords attackers actually try first
 *  • rejects passwords derived from the user's own email or name
 *  • no forced rotation — it drives people to predictable increments
 */
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 65_536, // 64 MiB
  timeCost: 3,
  parallelism: 1,
} as const;

const MIN_LENGTH = 10;
const MAX_LENGTH = 200; // bound the work an unauthenticated caller can ask us to do

/**
 * A small embedded list of the passwords that dominate credential-stuffing attempts.
 * A network breach-list check (HIBP k-anonymity, per docs/security.md §2) is a separate
 * concern: it needs an outbound call, a timeout and a failure policy, so it arrives with
 * the integrations framework rather than being bolted on here.
 */
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  '12345678',
  '123456789',
  '1234567890',
  'qwerty',
  'qwerty123',
  'qwertyuiop',
  'abc123456',
  'iloveyou',
  'admin123',
  'welcome1',
  'welcome123',
  'letmein123',
  'monkey123',
  'dragon123',
  'sunshine1',
  'princess1',
  'football1',
  'baseball1',
  'trustno1',
  'password!',
  'india@123',
  'india123',
  'admin@123',
  'changeme',
  'changeme123',
  'secret123',
  'test1234',
  'temp1234',
  'pass1234',
]);

@Injectable()
export class PasswordService {
  async hash(plaintext: string): Promise<string> {
    return hash(plaintext, ARGON2_OPTIONS);
  }

  /**
   * @returns `valid` plus `needsRehash` when the stored hash used weaker parameters than
   *          the current policy — the caller upgrades it transparently on next login.
   */
  async verify(
    storedHash: string,
    plaintext: string,
  ): Promise<{ valid: boolean; needsRehash: boolean }> {
    try {
      const valid = await verify(storedHash, plaintext, ARGON2_OPTIONS);
      return { valid, needsRehash: valid && this.isOutdated(storedHash) };
    } catch {
      // Malformed or unreadable hash: treat as a failed attempt, never as a pass.
      return { valid: false, needsRehash: false };
    }
  }

  /** Throws `AppError` with per-field details so the client can render them inline. */
  assertAcceptable(password: string, context: { email?: string; name?: string } = {}): void {
    const problems: string[] = [];

    if (password.length < MIN_LENGTH) problems.push(`must be at least ${MIN_LENGTH} characters`);
    if (password.length > MAX_LENGTH) problems.push(`must be at most ${MAX_LENGTH} characters`);

    const normalized = password.toLowerCase().trim();
    if (COMMON_PASSWORDS.has(normalized)) problems.push('is too common');
    if (/^(.)\1+$/.test(password)) problems.push('cannot be a single repeated character');
    if (isSequential(normalized)) problems.push('cannot be a simple sequence');

    const localPart = context.email?.split('@')[0]?.toLowerCase();
    if (localPart && localPart.length >= 3 && normalized.includes(localPart)) {
      problems.push('cannot contain your email address');
    }
    for (const part of (context.name ?? '').toLowerCase().split(/\s+/)) {
      if (part.length >= 4 && normalized.includes(part)) {
        problems.push('cannot contain your name');
        break;
      }
    }

    if (problems.length > 0) {
      throw AppError.validation('Password does not meet the requirements', [
        { field: 'password', code: 'WEAK_PASSWORD', message: `Password ${problems.join('; ')}.` },
      ]);
    }
  }

  private isOutdated(storedHash: string): boolean {
    const match = /\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
    if (!match) return true; // not argon2id at current version ⇒ upgrade
    const [, memory, time, parallelism] = match;
    return (
      Number(memory) < ARGON2_OPTIONS.memoryCost ||
      Number(time) < ARGON2_OPTIONS.timeCost ||
      Number(parallelism) !== ARGON2_OPTIONS.parallelism
    );
  }
}

function isSequential(value: string): boolean {
  if (value.length < 6) return false;
  let ascending = true;
  let descending = true;
  for (let i = 1; i < value.length; i += 1) {
    const delta = value.charCodeAt(i) - value.charCodeAt(i - 1);
    if (delta !== 1) ascending = false;
    if (delta !== -1) descending = false;
  }
  return ascending || descending;
}
