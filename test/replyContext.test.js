'use strict';

/**
 * Reply banner author formatting (#5564).
 * Bot/webhook parents have user_id NULL; the name lives on webhook_username.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const {
  replyAuthorUsername,
  toReplyContext,
} = require('../src/socketHandlers/helpers');

test('webhook bot uses [BOT] webhook_username', () => {
  assert.equal(
    replyAuthorUsername({
      is_webhook: 1,
      webhook_username: 'LOLbot',
      username: '[Deleted User]',
    }),
    '[BOT] LOLbot'
  );
});

test('webhook without a name falls back to [BOT] Bot', () => {
  assert.equal(
    replyAuthorUsername({ is_webhook: 1, webhook_username: null, username: null }),
    '[BOT] Bot'
  );
});

test('imported messages use webhook_username without the BOT prefix', () => {
  assert.equal(
    replyAuthorUsername({
      is_webhook: 0,
      imported_from: 'discord',
      webhook_username: 'Alice',
      username: '[Deleted User]',
    }),
    'Alice'
  );
  assert.equal(
    replyAuthorUsername({
      imported_from: 'discord',
      webhook_username: null,
      username: '[Deleted User]',
    }),
    'Unknown'
  );
});

test('persona username wins over the real account name', () => {
  assert.equal(
    replyAuthorUsername({
      persona_username: 'SecretSelf',
      username: 'realuser',
    }),
    'SecretSelf'
  );
});

test('regular users keep their COALESCE username', () => {
  assert.equal(
    replyAuthorUsername({ username: 'andrew', user_id: 3 }),
    'andrew'
  );
});

test('missing user row becomes [Deleted User]', () => {
  assert.equal(replyAuthorUsername({ username: null, user_id: null }), '[Deleted User]');
  assert.equal(replyAuthorUsername(null), '[Deleted User]');
});

test('webhook wins over persona and imported fields', () => {
  // Webhook rows are a different message type; persona must not override.
  assert.equal(
    replyAuthorUsername({
      is_webhook: 1,
      webhook_username: 'LOLbot',
      persona_username: 'ShouldNotWin',
      imported_from: 'discord',
      username: 'realuser',
    }),
    '[BOT] LOLbot'
  );
});

test('toReplyContext maps a SQL row into the banner shape', () => {
  assert.equal(toReplyContext(null), null);
  assert.deepEqual(
    toReplyContext({
      id: 42,
      content: 'ping',
      user_id: null,
      is_webhook: 1,
      webhook_username: 'LOLbot',
      username: '[Deleted User]',
    }),
    {
      id: 42,
      content: 'ping',
      user_id: null,
      username: '[BOT] LOLbot',
    }
  );
});

test('toReplyContext for a normal user keeps user_id and display name', () => {
  assert.deepEqual(
    toReplyContext({
      id: 7,
      content: 'hello',
      user_id: 3,
      is_webhook: 0,
      username: 'andrew',
    }),
    {
      id: 7,
      content: 'hello',
      user_id: 3,
      username: 'andrew',
    }
  );
});
