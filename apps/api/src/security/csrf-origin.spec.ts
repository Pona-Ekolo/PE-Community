import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSetupToken } from '../setup/setup.service';
import { csrfOriginProtection, requestOriginMatches } from './csrf-origin';

test('cookie-authenticated unsafe requests require the configured browser origin', () => {
  withEnvironment({ WEB_ORIGIN: 'https://community.example.com' }, () => {
    const allowed = runCsrf({
      method: 'POST',
      origin: 'https://community.example.com',
      cookie: 'pe_session=token',
    });
    assert.equal(allowed.next, true);

    const rejected = runCsrf({
      method: 'PATCH',
      origin: 'https://attacker.example',
      cookie: 'pe_session=token',
    });
    assert.deepEqual(rejected.response, {
      status: 403,
      body: {
        code: 'CSRF_ORIGIN_REJECTED',
        message: 'Request origin is not allowed.',
      },
    });
  });
});

test('CSRF origin protection does not block anonymous or safe-method requests', () => {
  withEnvironment({ WEB_ORIGIN: 'https://community.example.com' }, () => {
    assert.equal(
      runCsrf({ method: 'POST', origin: 'https://attacker.example' }).next,
      true,
    );
    assert.equal(
      runCsrf({
        method: 'GET',
        origin: 'https://attacker.example',
        cookie: 'pe_session=token',
      }).next,
      true,
    );
    assert.equal(
      requestOriginMatches(
        'https://community.example.com/path',
        'https://community.example.com',
      ),
      true,
    );
    assert.equal(
      requestOriginMatches(
        'https://community.example.com.attacker.example',
        'https://community.example.com',
      ),
      false,
    );
    assert.equal(
      requestOriginMatches(undefined, 'https://community.example.com'),
      false,
    );
  });
});

test('realtime origin policy accepts only the configured browser origin', () => {
  withEnvironment({ WEB_ORIGIN: 'https://community.example.com' }, () => {
    const configuredOrigin = 'https://community.example.com';
    assert.equal(
      requestOriginMatches('https://community.example.com', configuredOrigin),
      true,
    );
    assert.equal(
      requestOriginMatches('https://attacker.example', configuredOrigin),
      false,
    );
    assert.equal(requestOriginMatches(undefined, configuredOrigin), false);
  });
});

test('production setup requires a configured setup token and compares supplied tokens safely', () => {
  assert.throws(
    () => assertSetupToken(undefined, { NODE_ENV: 'production' }),
    /SETUP_TOKEN must be configured/,
  );
  assert.throws(
    () =>
      assertSetupToken('wrong', {
        NODE_ENV: 'production',
        SETUP_TOKEN: 'correct',
      }),
    /Setup token is required/,
  );
  assert.doesNotThrow(() =>
    assertSetupToken('correct', {
      NODE_ENV: 'production',
      SETUP_TOKEN: 'correct',
    }),
  );
  assert.doesNotThrow(() =>
    assertSetupToken(undefined, { NODE_ENV: 'development' }),
  );
});

function runCsrf(input: { method: string; origin?: string; cookie?: string }) {
  let next = false;
  let response: { status: number; body: unknown } | undefined;
  const req = {
    method: input.method,
    headers: input.cookie ? { cookie: input.cookie } : {},
    get: (name: string) =>
      name.toLowerCase() === 'origin' ? input.origin : undefined,
  };
  const res = {
    status: (status: number) => ({
      json: (body: unknown) => {
        response = { status, body };
        return undefined;
      },
    }),
  };
  csrfOriginProtection(req as never, res as never, () => {
    next = true;
  });
  return { next, response };
}

function withEnvironment(values: Record<string, string>, action: () => void) {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  try {
    action();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
