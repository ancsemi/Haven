'use strict';

const { isString, isInt } = require('./helpers');

module.exports = function register(socket, ctx) {
  const { io, db, state, userHasPermission, getUserEffectiveLevel, getUserHighestRole,
          broadcastVoiceUsers, emitOnlineUsers, handleVoiceLeave, touchVoiceActivity,
          getActiveMusicSyncState, getMusicQueuePayload } = ctx;
  const { channelUsers, voiceUsers, voiceLastActivity, activeMusic,
          activeScreenSharers, activeWebcamUsers, streamViewers } = state;

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
      return socket.emit('error-msg', 'Voice is disabled in this channel');
    }
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'use_voice', vch.id)) {
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

    if (!voiceUsers.has(code)) voiceUsers.set(code, new Map());

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
        // Stale entry — socket already disconnected; just clean up the map
        voiceUsers.get(code).delete(socket.user.id);
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
  socket.on('voice-offer', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isString(data.code, 8, 8) || !isInt(data.targetUserId) || !data.offer) return;
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

  // ── Webcam ──────────────────────────────────────────────
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
    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    const channelId = channel ? channel.id : null;
    const room = voiceUsers.get(code);
    const users = room
      ? Array.from(room.values()).map(u => {
          const role = getUserHighestRole(u.id, channelId);
          return { id: u.id, username: u.username, roleColor: role ? role.color : null, isMuted: u.isMuted || false, isDeafened: u.isDeafened || false };
        })
      : [];
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
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;

    const vch = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    if (!vch) return;
    const vMember = db.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
    ).get(vch.id, socket.user.id);
    if (!vMember) return;

    for (const [prevCode, room] of voiceUsers) {
      if (room.has(socket.user.id) && prevCode !== code) {
        handleVoiceLeave(socket, prevCode);
      }
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

    const existingUsers = Array.from(voiceUsers.get(code).values())
      .filter(u => u.id !== socket.user.id);

    socket.emit('voice-existing-users', {
      channelCode: code,
      users: existingUsers.map(u => ({ id: u.id, username: u.username }))
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
    for (const [code, room] of voiceUsers) {
      if (room.size > 0) {
        const users = Array.from(room.values()).map(u => ({ id: u.id, username: u.username, isMuted: u.isMuted || false, isDeafened: u.isDeafened || false }));
        socket.emit('voice-count-update', { code, count: room.size, users });
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
    if (!member) return;

    const members = db.prepare(`
      SELECT u.id, COALESCE(u.display_name, u.username) as username, u.username as loginName FROM users u
      JOIN channel_members cm ON u.id = cm.user_id
      WHERE cm.channel_id = ?
      ORDER BY COALESCE(u.display_name, u.username)
    `).all(channel.id);

    socket.emit('channel-members', { channelCode: code, members });
  });
};
