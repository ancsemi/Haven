'use strict';

const { isString, isInt } = require('./helpers');

module.exports = function register(socket, ctx) {
  const { io, db, state, userHasPermission, getUserEffectiveLevel, getUserHighestRole,
          broadcastVoiceUsers, emitOnlineUsers, handleVoiceLeave, touchVoiceActivity,
          pruneStaleVoiceUsers,
          getActiveMusicSyncState, getMusicQueuePayload } = ctx;
  const { channelUsers, voiceUsers, voiceLastActivity, activeMusic,
          activeScreenSharers, activeWebcamUsers, streamViewers, pendingTempDelete,
          pendingVoiceLeave } = state;

  // ── Local helper: broadcast stream/viewer info ──────────
  function broadcastStreamInfo(code) {
    const voiceRoom = voiceUsers.get(code);
    if (!voiceRoom) return;
    const sharers = activeScreenSharers.get(code);
    const streams = [];
    if (sharers) {
      for (const sharerId of sharers) {
        const sharerInfo = voiceRoom.get(sharerId);
        const viewers = streamViewers.get(`${code}:${sharerId}`);
        const viewerList = [];
        if (viewers) {
          for (const vid of viewers) {
            const vInfo = voiceRoom.get(vid);
            if (vInfo) viewerList.push({ id: vid, username: vInfo.username });
          }
        }
        streams.push({
          sharerId,
          sharerName: sharerInfo ? sharerInfo.username : 'Unknown',
          viewers: viewerList
        });
      }
    }
    io.to(`voice:${code}`).to(`channel:${code}`).emit('stream-viewers-update', { channelCode: code, streams });
  }

  // ── Voice join ──────────────────────────────────────────
  socket.on('voice-join', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;

    const vch = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    if (!vch) return;
    const vMember = db.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
    ).get(vch.id, socket.user.id);
    if (!vMember) return socket.emit('error-msg', 'Not a member of this channel');

    const vchSettings = db.prepare('SELECT voice_enabled, voice_user_limit, voice_bitrate FROM channels WHERE code = ?').get(code);
    if (vchSettings && vchSettings.voice_enabled === 0) {
      socket.emit('error-msg', 'Voice is disabled in this channel');
      socket.emit('voice-channel-gone', { code });
      return;
    }
    if (!socket.user.isAdmin && !socket.user.isGuest && !userHasPermission(socket.user.id, 'use_voice', vch.id)) {
      return socket.emit('error-msg', 'You don\'t have permission to use voice chat');
    }
    if (vchSettings && vchSettings.voice_user_limit > 0) {
      const currentCount = voiceUsers.has(code) ? voiceUsers.get(code).size : 0;
      if (currentCount >= vchSettings.voice_user_limit) {
        return socket.emit('error-msg', `Voice is full (${currentCount}/${vchSettings.voice_user_limit})`);
      }
    }

    // Leave any previous voice room first
    for (const [prevCode, room] of voiceUsers) {
      if (room.has(socket.user.id) && prevCode !== code) {
        handleVoiceLeave(socket, prevCode);
      }
    }

    // Cancel any pending grace-period eviction for this user+channel.
    // If we got here it means the user is consciously (re)joining via
    // voice-join, so the deferred eviction from a prior disconnect must
    // not fire later and yank them out.
    if (pendingVoiceLeave) {
      const pendingKey = `${socket.user.id}:${code}`;
      const pending = pendingVoiceLeave.get(pendingKey);
      if (pending) {
        clearTimeout(pending.timer);
        pendingVoiceLeave.delete(pendingKey);
        console.log(`[VoiceDiag] voice-join cancelled pending eviction for ${socket.user.username} on ${code}`);
      }
    }

    if (!voiceUsers.has(code)) voiceUsers.set(code, new Map());

    // Cancel any pending grace-period deletion for this temp-voice channel —
    // the user is rejoining before the 8-second window expired.
    if (pendingTempDelete && pendingTempDelete.has(code)) {
      clearTimeout(pendingTempDelete.get(code));
      pendingTempDelete.delete(code);
      console.log(`[Temporary] Grace-period deletion cancelled — user rejoined "${code}"`);
    }

    // If this user is already in the same voice channel (e.g. from another
    // client/tab), do a full voice-leave on the old socket so peer connections,
    // screen shares, and webcams are properly cleaned up.  Then notify the old
    // client so it resets its local voice UI.
    const existingEntry = voiceUsers.get(code).get(socket.user.id);
    if (existingEntry && existingEntry.socketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(existingEntry.socketId);
      if (oldSocket) {
        handleVoiceLeave(oldSocket, code);
        oldSocket.emit('voice-kicked', { channelCode: code, reason: 'Joined from another client' });
      } else {
        // Stale entry — socket already disconnected. Drop the map entry AND
        // broadcast voice-user-left to remaining peers so they tear down
        // their dead RTCPeerConnection. Without this, peers keep the dead
        // connection alive and apply the rejoiner's fresh offer on top of
        // it, breaking audio for everyone. (#5347 v3.15.4 — mirrors the
        // fix already in voice-rejoin's stale-entry path.)
        voiceUsers.get(code).delete(socket.user.id);
        const remaining = voiceUsers.get(code);
        if (remaining) {
          for (const [, u] of remaining) {
            io.to(u.socketId).emit('voice-user-left', {
              channelCode: code,
              user: { id: socket.user.id, username: socket.user.displayName }
            });
          }
        }
      }
    }

    // Re-create the map if handleVoiceLeave cleaned it up (last user left)
    if (!voiceUsers.has(code)) voiceUsers.set(code, new Map());

    socket.join(`voice:${code}`);

    const existingUsers = Array.from(voiceUsers.get(code).values())
      .filter(u => u.id !== socket.user.id);

    voiceUsers.get(code).set(socket.user.id, {
      id: socket.user.id,
      username: socket.user.displayName,
      socketId: socket.id,
      isMuted: false,
      isDeafened: false
    });

    voiceLastActivity.set(socket.user.id, Date.now());

    socket.emit('voice-existing-users', {
      channelCode: code,
      users: existingUsers.map(u => ({ id: u.id, username: u.username })),
      voiceBitrate: vchSettings ? (vchSettings.voice_bitrate || 0) : 0
    });

    existingUsers.forEach(u => {
      io.to(u.socketId).emit('voice-user-joined', {
        channelCode: code,
        user: { id: socket.user.id, username: socket.user.displayName }
      });
    });

    broadcastVoiceUsers(code);
    broadcastStreamInfo(code);

    // Send active music state to late joiner
    const music = activeMusic.get(code);
    if (music) {
      socket.emit('music-shared', {
        userId: music.userId,
        username: music.username,
        url: music.url,
        title: music.title,
        trackId: music.id,
        channelCode: code,
        resolvedFrom: music.resolvedFrom,
        syncState: getActiveMusicSyncState(music)
      });
    }
    socket.emit('music-queue-update', getMusicQueuePayload(code));

    // Send active screen share info — tell screen sharers to renegotiate
    const sharers = activeScreenSharers.get(code);
    if (sharers && sharers.size > 0) {
      socket.emit('active-screen-sharers', {
        channelCode: code,
        sharers: Array.from(sharers).map(uid => {
          const u = voiceUsers.get(code)?.get(uid);
          return u ? { id: uid, username: u.username } : null;
        }).filter(Boolean)
      });
      setTimeout(() => {
        for (const sharerId of sharers) {
          const sharerInfo = voiceUsers.get(code)?.get(sharerId);
          if (sharerInfo) {
            io.to(sharerInfo.socketId).emit('renegotiate-screen', {
              targetUserId: socket.user.id,
              channelCode: code
            });
          }
        }
      }, 2000);
    }

    // Send active webcam info — tell webcam users to renegotiate
    const camUsers = activeWebcamUsers.get(code);
    if (camUsers && camUsers.size > 0) {
      socket.emit('active-webcam-users', {
        channelCode: code,
        users: Array.from(camUsers).map(uid => {
          const u = voiceUsers.get(code)?.get(uid);
          return u ? { id: uid, username: u.username } : null;
        }).filter(Boolean)
      });
      setTimeout(() => {
        for (const camUserId of camUsers) {
          const camUserInfo = voiceUsers.get(code)?.get(camUserId);
          if (camUserInfo) {
            io.to(camUserInfo.socketId).emit('renegotiate-webcam', {
              targetUserId: socket.user.id,
              channelCode: code
            });
          }
        }
      }, 2500);
    }
  });

  // ── WebRTC signaling ────────────────────────────────────
  const MAX_SDP_SIZE = 16384; // 16 KB — generous limit for SDP offers/answers
  const MAX_ICE_SIZE = 2048;  // 2 KB — ICE candidates are small

  socket.on('voice-offer', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isString(data.code, 8, 8) || !isInt(data.targetUserId) || !data.offer) return;
    if (typeof data.offer !== 'object' || JSON.stringify(data.offer).length > MAX_SDP_SIZE) return;
    if (!voiceUsers.get(data.code)?.has(socket.user.id)) return;
    const target = voiceUsers.get(data.code)?.get(data.targetUserId);
    if (target) {
      io.to(target.socketId).emit('voice-offer', {
        from: { id: socket.user.id, username: socket.user.displayName },
        offer: data.offer,
        channelCode: data.code
      });
    }
  });

  socket.on('voice-answer', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isString(data.code, 8, 8) || !isInt(data.targetUserId) || !data.answer) return;
    if (typeof data.answer !== 'object' || JSON.stringify(data.answer).length > MAX_SDP_SIZE) return;
    if (!voiceUsers.get(data.code)?.has(socket.user.id)) return;
    const target = voiceUsers.get(data.code)?.get(data.targetUserId);
    if (target) {
      io.to(target.socketId).emit('voice-answer', {
        from: { id: socket.user.id, username: socket.user.displayName },
        answer: data.answer,
        channelCode: data.code
      });
    }
  });

  socket.on('voice-ice-candidate', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isString(data.code, 8, 8) || !isInt(data.targetUserId)) return;
    if (data.candidate && (typeof data.candidate !== 'object' || JSON.stringify(data.candidate).length > MAX_ICE_SIZE)) return;
    if (!voiceUsers.get(data.code)?.has(socket.user.id)) return;
    const target = voiceUsers.get(data.code)?.get(data.targetUserId);
    if (target) {
      io.to(target.socketId).emit('voice-ice-candidate', {
        from: { id: socket.user.id, username: socket.user.displayName },
        candidate: data.candidate,
        channelCode: data.code
      });
    }
  });

  // ── Voice leave ─────────────────────────────────────────
  socket.on('voice-leave', (data, callback) => {
    if (!data || typeof data !== 'object') return;
    if (!isString(data.code, 8, 8)) return;
    handleVoiceLeave(socket, data.code);
    if (typeof callback === 'function') callback({ ok: true });
  });

  // ── Voice kick ──────────────────────────────────────────
  socket.on('voice-kick', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isString(data.code, 8, 8)) return;
    if (!isInt(data.userId)) return;
    if (data.userId === socket.user.id) return;

    const voiceRoom = voiceUsers.get(data.code);
    if (!voiceRoom || !voiceRoom.has(socket.user.id)) return;

    const target = voiceRoom.get(data.userId);
    if (!target) return socket.emit('error-msg', 'User is not in voice');

    const kickCh = db.prepare('SELECT id FROM channels WHERE code = ?').get(data.code);
    const channelId = kickCh ? kickCh.id : null;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'kick_user', channelId)) {
      return socket.emit('error-msg', 'You don\'t have permission to kick users from voice');
    }

    const myLevel = getUserEffectiveLevel(socket.user.id, channelId);
    const targetLevel = getUserEffectiveLevel(data.userId, channelId);
    if (targetLevel >= myLevel) {
      return socket.emit('error-msg', 'You can\'t kick a user with equal or higher rank');
    }

    voiceRoom.delete(data.userId);
    const targetSocket = io.sockets.sockets.get(target.socketId);
    if (targetSocket) {
      targetSocket.leave(`voice:${data.code}`);
    }

    const sharers = activeScreenSharers.get(data.code);
    if (sharers) { sharers.delete(data.userId); if (sharers.size === 0) activeScreenSharers.delete(data.code); }

    const camUsersSet = activeWebcamUsers.get(data.code);
    if (camUsersSet) { camUsersSet.delete(data.userId); if (camUsersSet.size === 0) activeWebcamUsers.delete(data.code); }

    const viewerKey = `${data.code}:${data.userId}`;
    streamViewers.delete(viewerKey);
    for (const [key, viewers] of streamViewers) {
      if (key.startsWith(data.code + ':')) {
        viewers.delete(data.userId);
        if (viewers.size === 0) streamViewers.delete(key);
      }
    }

    io.to(target.socketId).emit('voice-kicked', {
      channelCode: data.code,
      kickedBy: socket.user.displayName
    });

    for (const [, user] of voiceRoom) {
      io.to(user.socketId).emit('voice-user-left', {
        channelCode: data.code,
        user: { id: data.userId, username: target.username }
      });
    }

    broadcastVoiceUsers(data.code);
    broadcastStreamInfo(data.code);
    socket.emit('error-msg', `Kicked ${target.username} from voice`);
  });

  // ── Screen sharing ──────────────────────────────────────
  socket.on('screen-share-started', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isString(data.code, 8, 8)) return;
    const voiceRoom = voiceUsers.get(data.code);
    if (!voiceRoom || !voiceRoom.has(socket.user.id)) return;

    const streamChannel = db.prepare('SELECT streams_enabled FROM channels WHERE code = ?').get(data.code);
    if (streamChannel && streamChannel.streams_enabled === 0 && !socket.user.isAdmin) {
      return socket.emit('error-msg', 'Screen sharing is disabled in this channel');
    }

    if (!activeScreenSharers.has(data.code)) activeScreenSharers.set(data.code, new Set());
    activeScreenSharers.get(data.code).add(socket.user.id);
    for (const [uid, user] of voiceRoom) {
      if (uid !== socket.user.id) {
        io.to(user.socketId).emit('screen-share-started', {
          userId: socket.user.id,
          username: socket.user.displayName,
          channelCode: data.code,
          hasAudio: !!data.hasAudio
        });
      }
    }
    broadcastStreamInfo(data.code);
  });

  socket.on('screen-share-stopped', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isString(data.code, 8, 8)) return;
    const voiceRoom = voiceUsers.get(data.code);
    if (!voiceRoom || !voiceRoom.has(socket.user.id)) return;

    const sharers = activeScreenSharers.get(data.code);
    if (sharers) { sharers.delete(socket.user.id); if (sharers.size === 0) activeScreenSharers.delete(data.code); }

    const viewerKey = `${data.code}:${socket.user.id}`;
    streamViewers.delete(viewerKey);
    for (const [uid, user] of voiceRoom) {
      if (uid !== socket.user.id) {
        io.to(user.socketId).emit('screen-share-stopped', {
          userId: socket.user.id,
          channelCode: data.code
        });
      }
    }
    broadcastStreamInfo(data.code);
  });

  // ── Screen renegotiate request (recovery handshake) ────
  // A receiver calls this when their stream tile failed to produce frames
  // (audio works but video stays black, or no tracks arrived after
  // screen-share-started fired). The server forwards a renegotiate-screen
  // to the sharer, which re-issues an offer for that specific peer.
  socket.on('request-screen-renegotiate', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isString(data.code, 8, 8)) return;
    if (!isInt(data.sharerId)) return;
    const voiceRoom = voiceUsers.get(data.code);
    if (!voiceRoom || !voiceRoom.has(socket.user.id)) return;
    const sharers = activeScreenSharers.get(data.code);
    if (!sharers || !sharers.has(data.sharerId)) return;
    const sharerInfo = voiceRoom.get(data.sharerId);
    if (!sharerInfo) return;
    io.to(sharerInfo.socketId).emit('renegotiate-screen', {
      targetUserId: socket.user.id,
      channelCode: data.code
    });
  });

  // ── Webcam ─────────────────────────────────────────────────
  socket.on('webcam-started', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isString(data.code, 8, 8)) return;
    const voiceRoom = voiceUsers.get(data.code);
    if (!voiceRoom || !voiceRoom.has(socket.user.id)) return;

    if (!activeWebcamUsers.has(data.code)) activeWebcamUsers.set(data.code, new Set());
    activeWebcamUsers.get(data.code).add(socket.user.id);

    for (const [uid, user] of voiceRoom) {
      if (uid !== socket.user.id) {
        io.to(user.socketId).emit('webcam-started', {
          userId: socket.user.id,
          username: socket.user.displayName,
          channelCode: data.code
        });
      }
    }
  });

  socket.on('webcam-stopped', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isString(data.code, 8, 8)) return;
    const voiceRoom = voiceUsers.get(data.code);
    if (!voiceRoom || !voiceRoom.has(socket.user.id)) return;

    const camUsersSet = activeWebcamUsers.get(data.code);
    if (camUsersSet) {
      camUsersSet.delete(socket.user.id);
      if (camUsersSet.size === 0) activeWebcamUsers.delete(data.code);
    }

    for (const [uid, user] of voiceRoom) {
      if (uid !== socket.user.id) {
        io.to(user.socketId).emit('webcam-stopped', {
          userId: socket.user.id,
          channelCode: data.code
        });
      }
    }
  });

  // ── Stream viewer tracking ──────────────────────────────
  socket.on('stream-watch', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isString(data.code, 8, 8)) return;
    if (!isInt(data.sharerId)) return;
    const voiceRoom = voiceUsers.get(data.code);
    if (!voiceRoom || !voiceRoom.has(socket.user.id)) return;
    const key = `${data.code}:${data.sharerId}`;
    if (!streamViewers.has(key)) streamViewers.set(key, new Set());
    streamViewers.get(key).add(socket.user.id);
    broadcastStreamInfo(data.code);
  });

  socket.on('stream-unwatch', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isString(data.code, 8, 8)) return;
    if (!isInt(data.sharerId)) return;
    const viewers = streamViewers.get(`${data.code}:${data.sharerId}`);
    if (viewers) {
      viewers.delete(socket.user.id);
      if (viewers.size === 0) streamViewers.delete(`${data.code}:${data.sharerId}`);
    }
    broadcastStreamInfo(data.code);
  });

  // ── Voice state ─────────────────────────────────────────
  socket.on('request-online-users', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    emitOnlineUsers(code);
  });

  socket.on('request-voice-users', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    // Prune stale entries (sockets that have already disconnected but
    // weren't cleaned up by handleVoiceLeave for whatever reason) BEFORE
    // computing the response. Without this, after a server restart the
    // requester can momentarily see the OLD pre-restart roster (or worse,
    // duplicates while clients reconnect) and the right voice panel /
    // sidebar count would stick on those ghosts until the next
    // broadcastVoiceUsers tick.
    const removed = pruneStaleVoiceUsers(code);
    if (removed && removed.length) {
      // Re-broadcast the freshly-pruned roster to everyone in the room
      // so other clients also reconcile, not just the requester.
      broadcastVoiceUsers(code);
    }
    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    const channelId = channel ? channel.id : null;
    const room = voiceUsers.get(code);
    const users = room
      ? Array.from(room.values()).map(u => {
          const role = getUserHighestRole(u.id, channelId);
          return { id: u.id, username: u.username, roleColor: role ? role.color : null, isMuted: u.isMuted || false, isDeafened: u.isDeafened || false };
        })
      : [];
    // Diagnostic for the recurring "I vanished from my own voice panel"
    // bug. If the client claims to be in voice on this channel but the
    // server has no record of them, log loudly so we can see it in
    // production logs. The client's voice-users-update self-heal will
    // emit voice-rejoin a moment after receiving our response, which
    // will rebind their voice slot.
    if (data.iAmInVoice && socket.user && !users.some(u => u.id === socket.user.id)) {
      const inAnyRoom = Array.from(voiceUsers.values()).some(r => r.has(socket.user.id));
      console.warn(
        `[VoiceDiag] request-voice-users from ${socket.user.username} (id=${socket.user.id}) ` +
        `claims to be in voice on ${code} but server has no entry. ` +
        `inAnyOtherVoiceRoom=${inAnyRoom}, currentSocketId=${socket.id}, ` +
        `roomSize=${room ? room.size : 0}`
      );

      // ── SERVER-SIDE PROACTIVE HEAL ──────────────────────
      // Don't just complain — reattach the user right here so the
      // infinite watchdog loop ("self ABSENT → poll → still ABSENT")
      // breaks immediately. The user has already proven (by being
      // connected with a valid socket and claiming to be in voice on
      // this channel) that they want to be in voice. We validate they
      // are actually a member of the channel; if so, we add them back
      // to voiceUsers, broadcast to peers, and send them a fresh
      // voice-existing-users so they (re-)negotiate RTCPeerConnections
      // with anyone who's in the room.
      try {
        const vch = db.prepare('SELECT id, voice_enabled FROM channels WHERE code = ?').get(code);
        if (!vch) {
          console.warn(`[VoiceDiag] PROACTIVE HEAL skipped — channel ${code} not in DB; signalling client to clean up.`);
          socket.emit('voice-channel-gone', { code });
        } else if (vch.voice_enabled === 0) {
          console.warn(`[VoiceDiag] PROACTIVE HEAL skipped — voice disabled in channel ${code}; signalling client to clean up.`);
          socket.emit('error-msg', 'Voice is disabled in this channel');
          socket.emit('voice-channel-gone', { code });
        } else {
          const vMember = db.prepare(
            'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
          ).get(vch.id, socket.user.id);
          if (!vMember) {
            console.warn(`[VoiceDiag] PROACTIVE HEAL skipped — ${socket.user.username} is not a member of channel ${code}; signalling client to clean up.`);
            socket.emit('voice-channel-gone', { code });
          } else {
            // Cancel any pending grace-period eviction for this slot.
            const pendingKey = `${socket.user.id}:${code}`;
            const pending = pendingVoiceLeave && pendingVoiceLeave.get(pendingKey);
            if (pending) {
              clearTimeout(pending.timer);
              pendingVoiceLeave.delete(pendingKey);
              console.log(`[VoiceDiag] PROACTIVE HEAL cancelled pending grace eviction for ${socket.user.username} on ${code}`);
            }
            if (!voiceUsers.has(code)) voiceUsers.set(code, new Map());
            socket.join(`voice:${code}`);
            voiceUsers.get(code).set(socket.user.id, {
              id: socket.user.id,
              username: socket.user.displayName,
              socketId: socket.id,
              isMuted: false,
              isDeafened: false
            });
            voiceLastActivity.set(socket.user.id, Date.now());
            console.log(`[VoiceDiag] PROACTIVE HEAL added ${socket.user.username} (id=${socket.user.id}) to voiceUsers[${code}]. Broadcasting to peers + sending voice-existing-users.`);

            const existingUsers = Array.from(voiceUsers.get(code).values())
              .filter(u => u.id !== socket.user.id);
            const vchSettings = db.prepare('SELECT voice_bitrate FROM channels WHERE code = ?').get(code);
            socket.emit('voice-existing-users', {
              channelCode: code,
              users: existingUsers.map(u => ({ id: u.id, username: u.username })),
              voiceBitrate: vchSettings ? (vchSettings.voice_bitrate || 0) : 0
            });
            // Notify existing peers that we're (back) in the room so
            // they wait for our offer. (voice-existing-users above tells
            // us to make the offers.)
            existingUsers.forEach(u => {
              io.to(u.socketId).emit('voice-user-joined', {
                channelCode: code,
                user: { id: socket.user.id, username: socket.user.displayName }
              });
            });
            broadcastVoiceUsers(code);
            broadcastStreamInfo(code);
            // Re-fetch the room so the response below includes us.
            const healedRoom = voiceUsers.get(code);
            const healedUsers = healedRoom
              ? Array.from(healedRoom.values()).map(u => {
                  const role = getUserHighestRole(u.id, vch.id);
                  return { id: u.id, username: u.username, roleColor: role ? role.color : null, isMuted: u.isMuted || false, isDeafened: u.isDeafened || false };
                })
              : [];
            socket.emit('voice-users-update', { channelCode: code, users: healedUsers });
            return; // We've already sent the update — don't double-send below.
          }
        }
      } catch (e) {
        console.warn(`[VoiceDiag] PROACTIVE HEAL failed:`, e && e.message);
      }
    }
    socket.emit('voice-users-update', { channelCode: code, users });
  });

  socket.on('voice-mute-state', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const room = voiceUsers.get(code);
    if (!room || !room.has(socket.user.id)) return;
    room.get(socket.user.id).isMuted = !!data.muted;
    if (!data.muted) touchVoiceActivity(socket.user.id);
    broadcastVoiceUsers(code);
  });

  socket.on('voice-speaking', (data) => {
    if (!data || typeof data !== 'object') return;
    for (const [code, room] of voiceUsers) {
      if (room.has(socket.user.id)) {
        io.to(`voice:${code}`).emit('voice-speaking', {
          userId: socket.user.id,
          speaking: !!data.speaking
        });
        break;
      }
    }
  });

  socket.on('voice-activity', () => {
    touchVoiceActivity(socket.user.id);
    if (socket.user.status === 'away') {
      try {
        db.prepare('UPDATE users SET status = ? WHERE id = ?').run('online', socket.user.id);
        socket.user.status = 'online';
        for (const [code, users] of channelUsers) {
          if (users.has(socket.user.id)) {
            users.get(socket.user.id).status = 'online';
            emitOnlineUsers(code);
          }
        }
        socket.emit('status-updated', { status: 'online', statusText: socket.user.statusText || '' });
      } catch { /* ignore */ }
    }
  });

  socket.on('voice-deafen-state', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const room = voiceUsers.get(code);
    if (!room || !room.has(socket.user.id)) return;
    room.get(socket.user.id).isDeafened = !!data.deafened;
    broadcastVoiceUsers(code);
  });

  // ── Voice rejoin (after reconnect) ──────────────────────
  socket.on('voice-rejoin', (data) => {
    // VERY top-of-handler log so we can prove the event reached us, and
    // catch every silent early-return below.
    console.log(`[VoiceDiag] voice-rejoin RECEIVED from ${socket.user?.username} (id=${socket.user?.id}) socket=${socket.id} data=${JSON.stringify(data)}`);
    if (!data || typeof data !== 'object') {
      console.warn(`[VoiceDiag] voice-rejoin REJECTED — bad payload`);
      return;
    }
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) {
      console.warn(`[VoiceDiag] voice-rejoin REJECTED — invalid code "${code}"`);
      return;
    }

    const vch = db.prepare('SELECT id, voice_enabled FROM channels WHERE code = ?').get(code);
    if (!vch) {
      console.warn(`[VoiceDiag] voice-rejoin REJECTED — channel ${code} not in DB (user=${socket.user.username}). Telling client channel is gone so it can clean local state.`);
      // Break the infinite watchdog/self-heal loop — tell the client the
      // channel no longer exists so it stops thinking it's in voice.
      socket.emit('voice-channel-gone', { code });
      return;
    }
    if (vch.voice_enabled === 0) {
      console.warn(`[VoiceDiag] voice-rejoin REJECTED — voice disabled in channel ${code} (user=${socket.user.username}).`);
      socket.emit('error-msg', 'Voice is disabled in this channel');
      socket.emit('voice-channel-gone', { code });
      return;
    }
    const vMember = db.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
    ).get(vch.id, socket.user.id);
    if (!vMember) {
      console.warn(`[VoiceDiag] voice-rejoin from ${socket.user.username} (id=${socket.user.id}) on ${code} REJECTED — not a channel member`);
      socket.emit('voice-channel-gone', { code });
      return;
    }

    // ── FAST PATH: pending grace-period eviction ───────────
    // If this user disconnected within the last few seconds, the
    // disconnect handler scheduled a deferred eviction instead of
    // immediately wiping them. Cancel it and just rebind the socketId on
    // the existing entry. This preserves their voiceUsers slot AND
    // means peers were never told voice-user-left, so their
    // RTCPeerConnections are still alive and audio continues
    // uninterrupted — no panel blanking, no missing-self glitch.
    const pendingKey = `${socket.user.id}:${code}`;
    const pending = pendingVoiceLeave && pendingVoiceLeave.get(pendingKey);
    if (pending) {
      clearTimeout(pending.timer);
      pendingVoiceLeave.delete(pendingKey);
      const existing = voiceUsers.get(code)?.get(socket.user.id);
      if (existing) {
        existing.socketId = socket.id;
        socket.join(`voice:${code}`);
        voiceLastActivity.set(socket.user.id, Date.now());
        console.log(`[VoiceDiag] voice-rejoin FAST PATH: rebound ${socket.user.username} on ${code} to socket ${socket.id} (no peer churn)`);
        // Tell the rejoining client about the current peer list so its
        // own UI is fresh, but do NOT re-emit voice-user-joined to peers
        // — they never saw us leave, so they don't need to renegotiate.
        const existingUsers = Array.from(voiceUsers.get(code).values())
          .filter(u => u.id !== socket.user.id);
        const vchSettings = db.prepare('SELECT voice_bitrate FROM channels WHERE code = ?').get(code);
        socket.emit('voice-existing-users', {
          channelCode: code,
          users: existingUsers.map(u => ({ id: u.id, username: u.username })),
          voiceBitrate: vchSettings ? (vchSettings.voice_bitrate || 0) : 0,
          // Hint to the client: skip building new RTCPeerConnections —
          // existing ones from before the blip are still live.
          skipRenegotiate: true
        });
        broadcastVoiceUsers(code);
        broadcastStreamInfo(code);
        return;
      }
      // No existing entry despite a pending timer — fall through to
      // normal rejoin path below.
    }
    const _hadRoomEntry = !!voiceUsers.get(code)?.has(socket.user.id);
    console.log(`[VoiceDiag] voice-rejoin: ${socket.user.username} (id=${socket.user.id}) on ${code} hadExisting=${_hadRoomEntry} newSocketId=${socket.id}`);

    for (const [prevCode, room] of voiceUsers) {
      if (room.has(socket.user.id) && prevCode !== code) {
        handleVoiceLeave(socket, prevCode);
      }
    }

    if (!voiceUsers.has(code)) voiceUsers.set(code, new Map());

    // CRITICAL: if this user already has an entry from a previous (now-stale)
    // socket, fully clean it up via handleVoiceLeave so other peers in the
    // room receive `voice-user-left` and tear down their stale
    // RTCPeerConnection. Without this, the rejoiner's fresh offer is applied
    // on top of a dead connection on every other client and audio never
    // recovers — exactly the "rejoined but can't hear each other" pattern
    // reported in #5347.
    let preservedMute = false;
    let preservedDeafen = false;
    const existingEntry = voiceUsers.get(code).get(socket.user.id);
    if (existingEntry) {
      preservedMute = !!existingEntry.isMuted;
      preservedDeafen = !!existingEntry.isDeafened;
      if (existingEntry.socketId !== socket.id) {
        const oldSocket = io.sockets.sockets.get(existingEntry.socketId);
        if (oldSocket) {
          handleVoiceLeave(oldSocket, code);
        } else {
          // Stale entry — old socket already gone, just drop the map entry
          // so the broadcasted voice-user-left below can fire.
          voiceUsers.get(code).delete(socket.user.id);
          for (const [, u] of voiceUsers.get(code)) {
            io.to(u.socketId).emit('voice-user-left', {
              channelCode: code,
              user: { id: socket.user.id, username: socket.user.displayName }
            });
          }
        }
        // handleVoiceLeave may have removed the room map entirely (if the
        // user was the only one in voice). Recreate it so we can re-add.
        if (!voiceUsers.has(code)) voiceUsers.set(code, new Map());
      }
    }

    socket.join(`voice:${code}`);

    voiceUsers.get(code).set(socket.user.id, {
      id: socket.user.id,
      username: socket.user.displayName,
      socketId: socket.id,
      isMuted: preservedMute,
      isDeafened: preservedDeafen
    });

    voiceLastActivity.set(socket.user.id, Date.now());

    const existingUsers = Array.from(voiceUsers.get(code).values())
      .filter(u => u.id !== socket.user.id);

    const vchSettings = db.prepare('SELECT voice_bitrate FROM channels WHERE code = ?').get(code);
    socket.emit('voice-existing-users', {
      channelCode: code,
      users: existingUsers.map(u => ({ id: u.id, username: u.username })),
      voiceBitrate: vchSettings ? (vchSettings.voice_bitrate || 0) : 0
    });

    existingUsers.forEach(u => {
      io.to(u.socketId).emit('voice-user-joined', {
        channelCode: code,
        user: { id: socket.user.id, username: socket.user.displayName }
      });
    });

    broadcastVoiceUsers(code);
    broadcastStreamInfo(code);

    const music = activeMusic.get(code);
    if (music) {
      socket.emit('music-shared', {
        userId: music.userId,
        username: music.username,
        url: music.url,
        title: music.title,
        trackId: music.id,
        channelCode: code,
        resolvedFrom: music.resolvedFrom,
        syncState: getActiveMusicSyncState(music)
      });
    }
    socket.emit('music-queue-update', getMusicQueuePayload(code));

    const sharers = activeScreenSharers.get(code);
    if (sharers && sharers.size > 0) {
      socket.emit('active-screen-sharers', {
        channelCode: code,
        sharers: Array.from(sharers).map(uid => {
          const u = voiceUsers.get(code)?.get(uid);
          return u ? { id: uid, username: u.username } : null;
        }).filter(Boolean)
      });
      setTimeout(() => {
        for (const sharerId of sharers) {
          const sharerInfo = voiceUsers.get(code)?.get(sharerId);
          if (sharerInfo) {
            io.to(sharerInfo.socketId).emit('renegotiate-screen', {
              targetUserId: socket.user.id,
              channelCode: code
            });
          }
        }
      }, 2000);
    }

    const camUsers = activeWebcamUsers.get(code);
    if (camUsers && camUsers.size > 0) {
      socket.emit('active-webcam-users', {
        channelCode: code,
        users: Array.from(camUsers).map(uid => {
          const u = voiceUsers.get(code)?.get(uid);
          return u ? { id: uid, username: u.username } : null;
        }).filter(Boolean)
      });
      setTimeout(() => {
        for (const camUserId of camUsers) {
          const camUserInfo = voiceUsers.get(code)?.get(camUserId);
          if (camUserInfo) {
            io.to(camUserInfo.socketId).emit('renegotiate-webcam', {
              targetUserId: socket.user.id,
              channelCode: code
            });
          }
        }
      }, 2500);
    }
  });

  // ── Voice counts / channel members ──────────────────────
  socket.on('get-voice-counts', () => {
    // Prune ghost entries first so the requesting client doesn't replace
    // an already-clean sidebar with a stale snapshot. If pruning actually
    // removed users, also rebroadcast the fresh roster so every other
    // client reconciles too. (#5347 follow-up.)
    for (const code of Array.from(voiceUsers.keys())) {
      const removed = pruneStaleVoiceUsers(code);
      const room = voiceUsers.get(code);
      if (room && room.size > 0) {
        const users = Array.from(room.values()).map(u => ({ id: u.id, username: u.username, isMuted: u.isMuted || false, isDeafened: u.isDeafened || false }));
        socket.emit('voice-count-update', { code, count: room.size, users });
        if (removed.length) broadcastVoiceUsers(code);
      } else {
        socket.emit('voice-count-update', { code, count: 0, users: [] });
      }
    }
  });

  socket.on('get-channel-members', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;

    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    if (!channel) return;

    const member = db.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
    ).get(channel.id, socket.user.id);
    // enter-channel auto-joins admins to non-DM channels they aren't members
    // of; mirror that here. Without it an admin who reached a channel that way
    // gets no reply at all, the client keeps its stale member list, and
    // @mention autocomplete comes up empty with nothing logged anywhere.
    if (!member) {
      const chRow = db.prepare('SELECT is_dm FROM channels WHERE id = ?').get(channel.id);
      if (!(socket.user.isAdmin && chRow && !chRow.is_dm)) return;
    }

    const members = db.prepare(`
      SELECT u.id, COALESCE(u.display_name, u.username) as username, u.username as loginName FROM users u
      JOIN channel_members cm ON u.id = cm.user_id
      WHERE cm.channel_id = ?
      ORDER BY COALESCE(u.display_name, u.username)
    `).all(channel.id);

    socket.emit('channel-members', { channelCode: code, members });
  });
};
