'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  UnsafeCallbackError,
  createPinnedLookup,
  postWebhookCallback,
  resolveCallbackDestination,
  validateCallbackUrl
} = require('../src/webhookCallback');

test('callback URL validation rejects credentials and local address forms', () => {
  assert.equal(validateCallbackUrl('ftp://example.com/hook'), false);
  assert.equal(validateCallbackUrl('https://user:secret@example.com/hook'), false);
  assert.equal(validateCallbackUrl('http://127.0.0.2/hook'), false);
  assert.equal(validateCallbackUrl('http://2130706433/hook'), false);
  assert.equal(validateCallbackUrl('http://0x7f000001/hook'), false);
  assert.equal(validateCallbackUrl('http://[::1]/hook'), false);
  assert.equal(validateCallbackUrl('http://[::ffff:7f00:1]/hook'), false);
  assert.equal(validateCallbackUrl('http://[::7f00:1]/hook'), false);
  assert.equal(validateCallbackUrl('http://[::ffff:0:7f00:1]/hook'), false);
  assert.equal(validateCallbackUrl('http://[2001:2::1]/hook'), false);
  assert.equal(validateCallbackUrl('http://[2001:20::1]/hook'), false);
  assert.equal(validateCallbackUrl('http://[4000::1]/hook'), false);
  assert.equal(validateCallbackUrl('http://service.local/hook'), false);
  assert.equal(validateCallbackUrl('https://example.com/hook'), true);
  assert.equal(validateCallbackUrl('https://[2606:4700:4700::1111]/hook'), true);
});

test('private callback opt-in permits local bots but never link-local metadata', async () => {
  assert.equal(validateCallbackUrl('http://127.0.0.2/hook', true), true);
  assert.equal(validateCallbackUrl('http://[::1]/hook', true), true);
  assert.equal(validateCallbackUrl('http://[fd00::7]/hook', true), true);
  assert.equal(validateCallbackUrl('http://[fe80::1]/hook', true), false);
  assert.equal(validateCallbackUrl('http://169.254.169.254/latest/meta-data', true), false);

  const local = await resolveCallbackDestination('http://bot.internal/hook', {
    allowPrivateCallbacks: true,
    lookup: async () => [{ address: '10.0.0.7', family: 4 }]
  });
  assert.equal(local.address, '10.0.0.7');

  await assert.rejects(
    resolveCallbackDestination('http://metadata.example/hook', {
      allowPrivateCallbacks: true,
      lookup: async () => [{ address: '169.254.169.254', family: 4 }]
    }),
    error => error instanceof UnsafeCallbackError && /blocked network/.test(error.message)
  );
});

test('DNS resolution is rejected when any answer points to a blocked network', async () => {
  await assert.rejects(
    resolveCallbackDestination('https://mixed.example/hook', {
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.9', family: 4 }
      ]
    }),
    error => error instanceof UnsafeCallbackError && /blocked network/.test(error.message)
  );
});

test('pinned lookup always returns the address that passed validation', () => {
  const lookup = createPinnedLookup('93.184.216.34', 4);
  lookup('changed.example', {}, (error, address, family) => {
    assert.ifError(error);
    assert.equal(address, '93.184.216.34');
    assert.equal(family, 4);
  });
  lookup('changed.example', { all: true }, (error, addresses) => {
    assert.ifError(error);
    assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]);
  });
});

test('HTTP delivery uses the validated address without a second DNS lookup', async () => {
  const originalRequest = http.request;
  let dnsLookups = 0;

  try {
    http.request = (url, options, onResponse) => {
      assert.equal(url.hostname, 'callback.example');
      assert.equal(options.agent, false);
      assert.equal(options.headers['Content-Length'], Buffer.byteLength('{"event":"olá"}'));
      options.lookup(url.hostname, {}, (error, address, family) => {
        assert.ifError(error);
        assert.equal(address, '93.184.216.34');
        assert.equal(family, 4);
      });

      const request = new EventEmitter();
      request.end = payload => {
        assert.equal(payload, '{"event":"olá"}');
        process.nextTick(() => {
          const response = new PassThrough();
          response.statusCode = 204;
          onResponse(response);
          response.end();
        });
      };
      request.destroy = error => request.emit('error', error);
      return request;
    };

    const response = await postWebhookCallback(
      'http://callback.example/hook',
      '{"event":"olá"}',
      { 'Content-Type': 'application/json' },
      {
        timeoutMs: 1000,
        lookup: async () => {
          dnsLookups++;
          return [{ address: '93.184.216.34', family: 4 }];
        }
      }
    );

    assert.equal(dnsLookups, 1);
    assert.deepEqual(response, { ok: true, status: 204 });
  } finally {
    http.request = originalRequest;
  }
});

test('callback deadline includes DNS resolution', async () => {
  await assert.rejects(
    postWebhookCallback('https://slow-dns.example/hook', '{}', {}, {
      timeoutMs: 20,
      lookup: () => new Promise(() => {})
    }),
    /DNS resolution timed out/
  );
});
