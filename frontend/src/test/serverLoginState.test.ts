import { describe, expect, it } from 'vitest';
import { buildServerLoginAttemptFromResponse } from '../utils/serverLoginState';

describe('server login result state', () => {
  it.each([
    ['target_busy', 'Login is blocked by an active radio operation.'],
    ['radio_busy', 'Login is blocked by an active radio operation.'],
    ['queue_full', "We couldn't start the login request."],
    ['transport_unavailable', "We couldn't start the login request."],
    ['send_failed', "We couldn't start the login request."],
  ] as const)(
    'treats %s as an unsent request rather than a server rejection',
    (reason, summary) => {
      const attempt = buildServerLoginAttemptFromResponse(
        'password',
        {
          status: 'error',
          authenticated: false,
          reason,
          message: 'Safe retry guidance',
        },
        'repeater'
      );

      expect(attempt).toMatchObject({
        outcome: 'request_failed',
        heardBack: false,
        summary,
        details: 'Safe retry guidance',
      });
    }
  );

  it('keeps a real login rejection distinct from admission blockers', () => {
    const attempt = buildServerLoginAttemptFromResponse(
      'password',
      {
        status: 'error',
        authenticated: false,
        reason: 'rejected',
        message: 'The repeater did not confirm this login.',
      },
      'repeater'
    );

    expect(attempt).toMatchObject({
      outcome: 'not_confirmed',
      heardBack: true,
      summary: 'Login was not confirmed.',
    });
  });
});
