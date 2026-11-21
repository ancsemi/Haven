'use strict';

// Bot accounts (src/botAccounts.js): made in Settings, signed in to with a
// token, looked after by its Bot Creators, and able to post embeds and buttons
// whose clicks come straight back over the bot's own connection.
//
//   node --test test/botAccounts.test.js

const assert = require('node:assert/strict');
const test = require('node:test');
const { io } = require('socket.io-client');
const { createHarness, wait } = require('./socketServerHarness');

const h = createHarness(3653, 'bot-accounts');
test.before(() => h.start());
test.after(() => h.stop());

// True when the server turns the token away.
const tryToken = (token) => new Promise((res) => {
  const sock = io('http://localhost:3653', { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false });
  sock.on('connect', () => { sock.close(); res(false); });
  sock.on('connect_error', () => { sock.close(); res(true); });
});

test('a bot account signs in with its token and works like a member', async () => {
  const admin = await h.register('admin');
  const bob = await h.register('bob');
  const A = await h.connect(admin.token);
  const B = await h.connect(bob.token);
  await wait(300);

  const list = h.next(A, 'channels-list', (c) => Array.isArray(c) && c.some((x) => x.name === 'lobby'));
  A.emit('create-channel', { name: 'lobby' });
  const code = (await list).find((c) => c.name === 'lobby').code;
  // A second channel, so taking the bot out of lobby does not leave it in
  // none (an account with no channel is put back into the open ones).
  const second = h.next(A, 'channels-list', (c) => Array.isArray(c) && c.some((x) => x.name === 'other'));
  A.emit('create-channel', { name: 'other' });
  await second;
  B.emit('join-channel', { code });

  // Only Manage Bots (or the admin) makes one; the token comes back once.
  assert.ok((await h.ask(B, 'create-bot', { name: 'sneaky' })).error);
  const made = await h.ask(A, 'create-bot', { name: 'helper' });
  assert.ok(made.token, JSON.stringify(made));
  const botId = made.bot.id;
  assert.ok((await h.ask(A, 'create-bot', { name: 'HELPER' })).error, 'names are unique');

  // It has no password to sign in with.
  const login = await h.post('/api/auth/login', { username: 'helper', password: 'anything12345' });
  assert.ok(!login.token);

  const R = await h.connect(made.token);
  const info = await h.next(R, 'session-info');
  assert.equal(info.botAccount, true);

  // Like a new member it starts in the open channels, and channels are
  // changed the Manage members way.
  const where = await h.ask(A, 'get-member-channels', { userId: botId });
  assert.ok(where.channels.find((c) => c.code === code && c.inChannel && c.canRemove));
  assert.equal((await h.ask(A, 'update-channel-members', { code, add: [], remove: [botId] })).removed, 1);
  assert.equal((await h.ask(A, 'update-channel-members', { code, add: [botId], remove: [] })).added, 1);
  R.emit('join-channel', { code });
  B.emit('enter-channel', { code });
  await wait(300);

  // Its messages carry the BOT mark and its embeds and buttons.
  const arrives = h.next(B, 'new-message', (d) => d.channelCode === code && d.message.user_id === botId);
  R.emit('send-message', { code, content: '', embeds: [{ title: 'Poll' }], components: [{ type: 1, components: [{ type: 2, label: 'Yes', custom_id: 'yes' }] }] });
  const m = (await arrives).message;
  assert.equal(m.bot, true);
  assert.equal(m.embeds[0].title, 'Poll');

  // A member cannot post buttons.
  const plain = h.next(A, 'new-message', (d) => d.channelCode === code && d.message.user_id === bob.id);
  B.emit('send-message', { code, content: 'hi', components: [{ type: 1, components: [{ type: 2, label: 'x', custom_id: 'x' }] }] });
  assert.equal((await plain).message.components, undefined);

  // A click goes straight to the bot.
  const heard = h.next(R, 'bot-interaction');
  assert.deepEqual(await h.ask(B, 'bot-interaction', { messageId: m.id, customId: 'yes' }), { ok: true });
  const click = await heard;
  assert.equal(click.interaction.custom_id, 'yes');
  assert.equal(click.interaction.user.id, bob.id);

  // The bot greys its button out.
  const swapped = h.next(B, 'message-bot-parts', (d) => d.messageId === m.id);
  assert.deepEqual(await h.ask(R, 'edit-bot-parts', { messageId: m.id, components: [{ type: 1, components: [{ type: 2, label: 'Yes', custom_id: 'yes', disabled: true }] }] }), { success: true });
  assert.equal((await swapped).components[0].components[0].disabled, true);

  // Bob sees no bot until he is one of its Bot Creators, and even then
  // cannot change who they are or delete the bot.
  assert.deepEqual((await h.ask(B, 'get-bots')).bots, []);
  assert.ok((await h.ask(B, 'regenerate-bot-token', { botId })).error);
  assert.deepEqual(await h.ask(A, 'add-bot-creator', { botId, userId: bob.id }), { success: true });
  assert.equal((await h.ask(B, 'get-bots')).bots[0].id, botId);
  assert.ok((await h.ask(B, 'add-bot-creator', { botId, userId: admin.id })).error);
  assert.ok((await h.ask(B, 'remove-bot-creator', { botId, userId: bob.id })).error);
  // Signing in again, he is told he is a Bot Creator, which opens the
  // Bots page in Admin settings to him.
  const B2 = await h.connect(bob.token);
  assert.equal((await h.next(B2, 'session-info')).botCreator, true);
  assert.ok((await h.ask(B, 'delete-bot', { botId })).error);

  // A new token signs the bot out and the old one stops working.
  const out = h.next(R, 'disconnect');
  const fresh = await h.ask(B, 'regenerate-bot-token', { botId });
  assert.ok(fresh.token);
  assert.ok(await out);
  assert.equal(await tryToken(made.token), true);

  // Disabled, the token is refused; enabled again, the same token works.
  await h.ask(B, 'set-bot-disabled', { botId, disabled: true });
  assert.equal(await tryToken(fresh.token), true);
  await h.ask(B, 'set-bot-disabled', { botId, disabled: false });
  assert.equal(await tryToken(fresh.token), false);

  // The bot renames itself and keeps its token.
  const R2 = await h.connect(fresh.token);
  await wait(200);
  assert.deepEqual(await h.ask(R2, 'rename-bot', { botId, name: 'helper_two' }), { success: true, name: 'helper_two' });
  assert.equal(await tryToken(fresh.token), false);

  // It has posted, so only the admin deletes it, and its messages go too.
  const gone = await h.ask(A, 'delete-bot', { botId });
  assert.deepEqual(gone, { success: true });
  const hist = h.next(B, 'message-history', (d) => d && d.channelCode === code);
  B.emit('get-messages', { code });
  assert.equal((await hist).messages.some((x) => x.id === m.id), false);
});
