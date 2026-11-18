'use strict';

const { generateTokenAsync } = require('../auth');
const { nameRefusal } = require('../blockedNames');
const { badgesForProfile, getBadge, setBadgeHidden } = require('../badges');
const profile = require('../db/userProfiles');
const { nicknameUpsert, deleteNickname, nicknameEntries, lockUserPreferences } = require('../db/userPreferences');
const { normalizeDisplayName, parseBorderTransform, sanitizeText } = require('./helpers');
const { postingSettings, checkText } = require('./postgresPosting');
const createPermissions = require('./asyncPermissions');

function createPostgresProfiles({ io, db, permissions, presence, channelMembers, logAudit }) {
  const pending = new Map();

  async function checkProfileText(db, permissions, user, text) {
    if (!text || user.isAdmin) return;
    const saved = await postingSettings(db);
    const level = saved.automod_enabled === 'true' ? await permissions.getUserEffectiveLevel(user.id) : 0;
    await checkText(db, text, user, saved, { surface: 'profile', effectiveLevel: level });
  }

  return function register(socket, on, accessible) {
    const user = socket.user;

    function profileChange(handler) {
      return async data => {
        // Keep live updates from different devices in the same order as the
        // saved profile changes. The transactions also cover other processes.
        const previous = pending.get(user.id) || Promise.resolve();
        const change = previous.catch(() => { /* reported by its own handler */ }).then(() => handler(data));
        pending.set(user.id, change);
        try {
          await change;
        } finally {
          if (pending.get(user.id) === change) pending.delete(user.id);
        }
      };
    }

    function updateConnectedProfiles(fields) {
      for (const peer of io.sockets.sockets.values()) {
        if (peer.user.id === user.id) Object.assign(peer.user, fields);
      }
    }

    async function refreshProfile() {
      try {
        await presence.refreshUser(user.id, socket.currentChannel);
      } catch (err) {
        console.warn('[postgres-preview] profile presence refresh failed:', err.code || err.message);
      }
    }

    async function currentChannel() {
      if (!socket.currentChannel) return null;
      try {
        return await accessible(socket, socket.currentChannel);
      } catch (err) {
        // A socket can still be looking at a room it has lost access to.
        if (err.code) throw err;
        return null;
      }
    }

    on('get-user-profile', async data => {
      if (!Number.isSafeInteger(data?.userId) || data.userId <= 0) return;
      const row = await profile.readProfile(db, data.userId);
      if (!row) return;

      const roles = await profile.profileServerRoles(db, row.id);
      const channel = await currentChannel();
      if (channel) {
        const chain = await permissions.getChannelRoleChain(channel.id);
        if (chain.length) profile.mergeProfileRoles(roles, await profile.profileChannelRoles(db, row.id, chain));
      }
      const seesHidden = user.isAdmin || await permissions.userHasPermission(user.id, 'manage_roles');
      let badges = [];
      try {
        badges = await badgesForProfile(db, row.id, user.id);
      } catch (err) {
        console.warn('[badges] profile badges failed:', err.message);
      }
      const online = [...io.sockets.sockets.values()].some(peer => peer.user.id === row.id);
      socket.emit('user-profile', {
        ...profile.profileCard(row, user.id, online),
        roles: profile.visibleProfileRoles(roles, seesHidden), badges, activity: null,
      });
    });

    on('set-bio', profileChange(async data => {
      if (typeof data?.bio !== 'string') return;
      const bio = sanitizeText(data.bio.trim().slice(0, 190));
      await checkProfileText(db, permissions, user, bio);
      await profile.setBio(db, user.id, bio);
      updateConnectedProfiles({ bio });
      socket.emit('bio-updated', { bio });
    }));

    on('set-birthday', profileChange(async data => {
      if (!data || typeof data !== 'object') return;
      const birthday = data.birthday == null ? null : profile.cleanBirthday(data.birthday);
      if (data.birthday != null && !birthday) throw new Error('Invalid birthday');
      const change = await db.withTransaction(async tx => {
        const row = await profile.birthdayForUpdate(tx, user.id);
        if (!row) return;
        const next = profile.birthdayChange(row, data, birthday);
        if (next?.error) throw new Error(next.error);
        if (next) await profile.setBirthday(tx, user.id, next.value);
        return next;
      });
      if (!change) return;
      updateConnectedProfiles(change.value);
      socket.emit('birthday-updated', change.value);
      if (change.listsChanged) await refreshProfile();
    }));

    on('set-avatar-shape', profileChange(async data => {
      if (!data || typeof data !== 'object') return;
      const shape = profile.avatarShape(data.shape);
      await profile.setAvatarShape(db, user.id, shape);
      updateConnectedProfiles({ avatar_shape: shape });
      socket.emit('avatar-shape-updated', { shape });
      await refreshProfile();
    }));

    on('set-animate-profile', profileChange(async data => {
      if (!data || typeof data !== 'object') return;
      const mode = profile.animationMode(data.mode);
      await profile.setAnimationMode(db, user.id, mode);
      updateConnectedProfiles({ animate_profile: mode });
      socket.emit('animate-profile-updated', { mode });
      await refreshProfile();
    }));

    on('set-border-transform', profileChange(async data => {
      if (!data || typeof data !== 'object') return;
      // The HTTP endpoint already saved the fit. Re-read it before sending
      // the live update, since another tab may have edited it in the meantime.
      const row = await profile.readProfile(db, user.id);
      if (!row) return;
      updateConnectedProfiles({ borderTransform: parseBorderTransform(row.border_transform) });
      await refreshProfile();
    }));

    on('set-nickname', async data => {
      const targetId = parseInt(data?.targetId, 10);
      if (!Number.isSafeInteger(targetId) || targetId <= 0) return;
      const nickname = typeof data.nickname === 'string' ? data.nickname.trim().slice(0, 32) : '';
      await db.withTransaction(async tx => {
        await lockUserPreferences(tx, user.id);
        if (nickname) await nicknameUpsert(tx).run(user.id, targetId, nickname);
        else await deleteNickname(tx, user.id, targetId);
      });
    });

    on('set-nicknames-bulk', async data => {
      const map = data?.nicknames;
      if (!map || typeof map !== 'object') return;
      const entries = nicknameEntries(map).filter(([targetId]) => Number.isSafeInteger(targetId));
      if (!entries.length) return;
      await db.withTransaction(async tx => {
        await lockUserPreferences(tx, user.id);
        const upsert = nicknameUpsert(tx);
        for (const [targetId, nickname] of entries) await upsert.run(user.id, targetId, nickname);
      });
    });

    on('set-badge-hidden', async (data, callback) => {
      const answer = typeof callback === 'function' ? callback : () => {};
      if (typeof data?.hidden !== 'boolean') return answer({ error: 'Invalid request' });
      try {
        const saved = await db.withTransaction(async tx => {
          const badge = await getBadge(tx, data.badgeId);
          if (!badge) return false;
          await setBadgeHidden(tx, user.id, badge.id, data.hidden);
          return true;
        });
        return answer(saved ? { ok: true, hidden: data.hidden } : { error: 'Badge not found' });
      } catch (err) {
        console.error('[badges] hide failed:', err.message);
        return answer({ error: 'Could not save that' });
      }
    });

    on('rename-user', profileChange(async data => {
      if (!data || typeof data !== 'object') return;
      const checked = normalizeDisplayName(typeof data.username === 'string' ? data.username : '');
      if (checked.error) throw new Error(checked.error);
      const newName = checked.value;
      if (newName === user.displayName) return;

      const renamed = await db.withTransaction(async tx => {
        // Display names share an effective namespace with login names.
        // Use registration's lock for the check across different accounts.
        await profile.lockAccountNames(tx);
        const row = await profile.displayNameForUpdate(tx, user.id);
        if (!row || row.username !== user.username || (row.password_version || 1) !== user.pwv) {
          throw new Error('Session expired');
        }
        const oldName = row.display_name || row.username;
        if (newName === oldName) return;
        const isAdmin = !!row.is_admin;
        if (!isAdmin && row.display_name_locked) {
          throw new Error('A moderator set your display name, so you cannot change it yourself');
        }
        await checkProfileText(tx, createPermissions(tx), { ...user, isAdmin }, newName);
        const refused = isAdmin ? null : await nameRefusal(tx, newName);
        if (refused) throw new Error(refused);
        if (await profile.conflictingDisplayName(tx, user.id, newName)) {
          throw new Error('That display name is already taken on this server');
        }
        await profile.setDisplayName(tx, user.id, newName);
        return { oldName, isAdmin, partners: await profile.dmPartners(tx, user.id) };
      });
      if (!renamed) return;

      const { oldName, isAdmin, partners } = renamed;
      updateConnectedProfiles({ displayName: newName });
      const account = { id: user.id, username: user.username, isAdmin, displayName: newName };
      const token = await generateTokenAsync({ ...account, pwv: user.pwv });
      socket.sessionToken = token;
      socket.emit('renamed', { token, user: account, oldName });

      const partnerIds = new Set(partners.map(row => row.user_id));
      for (const peer of io.sockets.sockets.values()) {
        if (partnerIds.has(peer.user.id)) peer.emit('dm-name-updated', { userId: user.id, newName });
      }
      await logAudit({ actor: account, action: 'user_rename', target_type: 'user', target_id: user.id,
        target_name: newName, details: { oldName, newName } });
      try {
        const channel = await currentChannel();
        if (channel) {
          const members = new Set((await channelMembers(db, channel, permissions)).map(member => member.id));
          const room = io.sockets.adapter.rooms.get('channel:' + channel.code);
          for (const id of room || []) {
            const peer = io.sockets.sockets.get(id);
            if (peer && peer.id !== socket.id && members.has(peer.user.id)) {
              peer.emit('user-renamed', { channelCode: channel.code, oldName, newName });
            }
          }
        }
      } catch (err) {
        console.warn('[postgres-preview] room rename announcement failed:', err.code || err.message);
      }
      await refreshProfile();
    }));
  };
}

module.exports = { createPostgresProfiles };
