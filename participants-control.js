'use strict';

const crypto = require('crypto');

const ACTIVE_STATUSES = new Set(['WAITING', 'ADMITTED', 'MUTED']);
const TICKET_TTL_MS = 60_000;

function createParticipantsControl({ io, rooms, liveKit }) {
  const participants = new Map();
  const admissionTickets = new Map();

  function channelRoom(channel, code) {
    // Room-code scoping prevents students in separate classes seeing one another.
    return `${channel}:${code}`;
  }

  function hostRoom(code) {
    return `teacher:${code}`;
  }

  function publicParticipant(entry) {
    return {
      id: entry.socketId,
      name: entry.name,
      role: entry.role,
      status: entry.status,
      room: entry.room,
      joinedAt: entry.joinedAt,
      videoIdentity: entry.liveKitIdentity || null,
      muted: entry.status === 'MUTED'
    };
  }

  function activeParticipants(code) {
    return [...participants.values()]
      .filter((entry) => entry.code === code && entry.role === 'PARTICIPANT' && ACTIVE_STATUSES.has(entry.status))
      .map(publicParticipant);
  }

  function emitParticipantList(code) {
    io.to(hostRoom(code)).emit('participant-list', activeParticipants(code));
  }

  function emitLobbyUpdate(code) {
    io.to(hostRoom(code)).emit('lobby-update', activeParticipants(code));
  }

  function notifyParticipant(socketId, event, payload) {
    const target = io.sockets.sockets.get(socketId);
    if (!target || !target.connected) return false;
    target.emit(event, payload);
    return true;
  }

  function authenticatedHost(socket, code) {
    const room = rooms.get(code);
    return Boolean(room && socket.data.participantRole === 'HOST' && socket.data.participantRoom === code);
  }

  function registerHandlers(socket) {
    socket.on('join-lobby', (payload, callback) => {
      const code = String(payload?.code || '').trim().toUpperCase().slice(0, 10);
      const room = rooms.get(code);
      const name = typeof payload?.name === 'string' ? payload.name.trim().slice(0, 40) : '';
      if (!room || !name) return callback?.({ ok: false, err: 'Valid room and name are required.' });

      const previous = participants.get(socket.id);
      if (previous && previous.code !== code) {
        socket.leave(channelRoom('main-room', previous.code));
        socket.leave(channelRoom('video-room', previous.code));
      }
      const entry = {
        socketId: socket.id,
        name,
        role: 'PARTICIPANT',
        status: previous?.code === code && ACTIVE_STATUSES.has(previous.status) ? previous.status : 'WAITING',
        room: previous?.code === code && previous.status !== 'WAITING' ? 'video-room' : 'main-room',
        code,
        joinedAt: previous?.code === code ? previous.joinedAt : Date.now(),
        liveKitIdentity: previous?.code === code ? previous.liveKitIdentity : null,
        pendingLiveKitIdentity: null
      };
      participants.set(socket.id, entry);
      socket.join(channelRoom('main-room', code));
      let admissionTicket = null;
      if (entry.status === 'ADMITTED' || entry.status === 'MUTED') {
        socket.leave(channelRoom('main-room', code));
        socket.join(channelRoom('video-room', code));
        admissionTicket = issueAdmissionTicket(entry);
      }
      emitParticipantList(code);
      emitLobbyUpdate(code);
      callback?.({ ok: true, status: entry.status, admissionTicket });
      if (entry.status === 'MUTED') notifyParticipant(socket.id, 'force-mute', { muted: true });
    });

    socket.on('host-join', (payload, callback) => {
      const code = String(payload?.code || '').trim().toUpperCase().slice(0, 10);
      const room = rooms.get(code);
      const token = typeof payload?.token === 'string' ? payload.token : '';
      if (!room || room.teacherToken !== token) {
        return callback?.({ ok: false, err: 'Teacher authentication failed.' });
      }

      socket.data.participantRole = 'HOST';
      socket.data.participantRoom = code;
      socket.join(hostRoom(code));
      socket.join(channelRoom('main-room', code));
      socket.join(channelRoom('video-room', code));
      participants.set(socket.id, {
        socketId: socket.id,
        name: 'Teacher',
        role: 'HOST',
        status: 'ADMITTED',
        room: 'video-room',
        code,
        joinedAt: Date.now()
      });
      emitParticipantList(code);
      emitLobbyUpdate(code);
      callback?.({ ok: true, participants: activeParticipants(code) });
    });

    socket.on('request-participant-list', (payload, callback) => {
      const code = String(payload?.code || '').trim().toUpperCase().slice(0, 10);
      if (!authenticatedHost(socket, code)) return callback?.({ ok: false, err: 'Host access required.' });
      callback?.({ ok: true, participants: activeParticipants(code) });
      emitParticipantList(code);
      emitLobbyUpdate(code);
    });

    socket.on('admit-participant', (payload, callback) => {
      const code = String(payload?.code || '').trim().toUpperCase().slice(0, 10);
      if (!authenticatedHost(socket, code)) return callback?.({ ok: false, err: 'Host access required.' });
      const entry = participants.get(String(payload?.participantId || ''));
      if (!entry || entry.code !== code || entry.role !== 'PARTICIPANT' || entry.status === 'KICKED') {
        return callback?.({ ok: false, err: 'Participant is no longer available.' });
      }
      if (entry.status === 'WAITING') {
        entry.status = 'ADMITTED';
        entry.room = 'video-room';
        const target = io.sockets.sockets.get(entry.socketId);
        if (target?.connected) {
          target.leave(channelRoom('main-room', code));
          target.join(channelRoom('video-room', code));
        }
      }
      const ticket = issueAdmissionTicket(entry);
      notifyParticipant(entry.socketId, 'participant-admitted', { room: 'video-room', admissionTicket: ticket });
      emitParticipantList(code);
      emitLobbyUpdate(code);
      callback?.({ ok: true });
    });

    socket.on('kick-participant', async (payload, callback) => {
      const code = String(payload?.code || '').trim().toUpperCase().slice(0, 10);
      if (!authenticatedHost(socket, code)) return callback?.({ ok: false, err: 'Host access required.' });
      const entry = participants.get(String(payload?.participantId || ''));
      if (!entry || entry.code !== code || entry.role !== 'PARTICIPANT') {
        return callback?.({ ok: true, alreadyRemoved: true });
      }
      if (entry.status === 'KICKED') return callback?.({ ok: true, alreadyRemoved: true });
      const reason = typeof payload?.reason === 'string' ? payload.reason.trim().slice(0, 300) : '';
      if (reason.length < 3) return callback?.({ ok: false, err: 'Enter a reason of at least 3 characters.' });

      const kickedAt = Date.now();
      entry.status = 'KICKED';
      admissionTickets.delete(entry.admissionTicket);
      const target = io.sockets.sockets.get(entry.socketId);
      if (target?.connected) {
        target.emit('participant-kicked', { reason, timestamp: kickedAt });
        setTimeout(() => target.disconnect(true), 100);
      }
      const liveKitIdentities = [...new Set([entry.liveKitIdentity, entry.pendingLiveKitIdentity].filter(Boolean))];
      if (liveKit) {
        for (const identity of liveKitIdentities) {
          try {
            await liveKit.removeParticipant(code, identity);
          } catch (error) {
            console.error(`Could not remove kicked participant ${entry.socketId} from LiveKit room ${code}.`, error);
          }
        }
      }
      emitParticipantList(code);
      emitLobbyUpdate(code);
      callback?.({ ok: true, reason, timestamp: kickedAt });
    });

    socket.on('mute-participant', async (payload, callback) => {
      const code = String(payload?.code || '').trim().toUpperCase().slice(0, 10);
      if (!authenticatedHost(socket, code)) return callback?.({ ok: false, err: 'Host access required.' });
      const entry = participants.get(String(payload?.participantId || ''));
      const muted = payload?.muted;
      if (!entry || entry.code !== code || entry.role !== 'PARTICIPANT' || !['ADMITTED', 'MUTED'].includes(entry.status)) {
        return callback?.({ ok: false, err: 'An admitted participant is required.' });
      }
      if (typeof muted !== 'boolean') return callback?.({ ok: false, err: 'Mute state must be true or false.' });

      if (entry.liveKitIdentity && liveKit) {
        try {
          const participant = await liveKit.getParticipant(code, entry.liveKitIdentity);
          const audioTracks = (participant.tracks || []).filter((track) => track.type === liveKit.TrackType.AUDIO);
          for (const track of audioTracks) {
            await liveKit.mutePublishedTrack(code, entry.liveKitIdentity, track.sid, muted);
          }
        } catch (error) {
          console.error(`Could not ${muted ? 'mute' : 'unmute'} participant ${entry.socketId} in LiveKit room ${code}.`, error);
          return callback?.({ ok: false, err: 'The video service could not apply the microphone change.' });
        }
      }
      entry.status = muted ? 'MUTED' : 'ADMITTED';
      notifyParticipant(entry.socketId, 'force-mute', { muted });
      emitParticipantList(code);
      emitLobbyUpdate(code);
      callback?.({ ok: true, muted });
    });

    socket.on('register-video-identity', async (payload, callback) => {
      const entry = participants.get(socket.id);
      if (!entry || entry.role !== 'PARTICIPANT') return callback?.({ ok: false, err: 'Participant is unavailable.' });
      const identity = typeof payload?.identity === 'string' ? payload.identity.slice(0, 100) : '';
      if (!identity.startsWith('student-')) return callback?.({ ok: false, err: 'Invalid video identity.' });
      if (entry.status === 'KICKED') {
        if (identity !== entry.pendingLiveKitIdentity && identity !== entry.liveKitIdentity) {
          return callback?.({ ok: false, err: 'Video access has been revoked.' });
        }
        if (liveKit) {
          try {
            await liveKit.removeParticipant(entry.code, identity);
          } catch (error) {
            console.error(`Could not remove late video connection for kicked participant ${entry.socketId}.`, error);
          }
        }
        return callback?.({ ok: true, removed: true });
      }
      if (!['ADMITTED', 'MUTED'].includes(entry.status)
        || (identity !== entry.pendingLiveKitIdentity && identity !== entry.liveKitIdentity)) {
        return callback?.({ ok: false, err: 'Video access has not been admitted.' });
      }
      entry.liveKitIdentity = identity;
      entry.pendingLiveKitIdentity = null;
      if (entry.status === 'MUTED') notifyParticipant(socket.id, 'force-mute', { muted: true });
      emitParticipantList(entry.code);
      emitLobbyUpdate(entry.code);
      callback?.({ ok: true });
    });

    socket.on('classroom-message', (payload, callback) => {
      const code = typeof socket.data.participantRoom === 'string'
        ? socket.data.participantRoom
        : participants.get(socket.id)?.code;
      const entry = participants.get(socket.id);
      const message = typeof payload?.message === 'string' ? payload.message.trim().slice(0, 1000) : '';
      if (!entry || !code || !message || (entry.role === 'PARTICIPANT' && !['ADMITTED', 'MUTED'].includes(entry.status))) {
        return callback?.({ ok: false, err: 'Join the classroom before sending a message.' });
      }
      const item = { from: entry.name, role: entry.role, message, timestamp: Date.now() };
      io.to(channelRoom('video-room', code)).emit('classroom-message', item);
      callback?.({ ok: true });
    });

    socket.on('private-chat-message', (payload, callback) => {
      const entry = participants.get(socket.id);
      const recipientId = typeof payload?.participantId === 'string' ? payload.participantId : '';
      const target = participants.get(recipientId);
      const message = typeof payload?.message === 'string' ? payload.message.trim().slice(0, 1000) : '';
      if (!entry || !message || !target || target.code !== entry.code || target.role !== 'PARTICIPANT') {
        return callback?.({ ok: false, err: 'That participant is not available.' });
      }
      if (entry.role === 'HOST' && !authenticatedHost(socket, entry.code)) {
        return callback?.({ ok: false, err: 'Host access required.' });
      }
      if (entry.role === 'PARTICIPANT' && (!['ADMITTED', 'MUTED'].includes(entry.status) || target.socketId !== socket.id)) {
        return callback?.({ ok: false, err: 'Private messages are not available.' });
      }
      const item = { from: entry.name, participantId: entry.socketId, message, timestamp: Date.now() };
      notifyParticipant(target.socketId, 'private-chat-message', item);
      if (entry.role === 'HOST') socket.emit('private-chat-message', item);
      callback?.({ ok: true });
    });

    socket.on('disconnect', () => {
      const entry = participants.get(socket.id);
      if (!entry) return;
      const code = entry.code;
      const departed = { ...publicParticipant({ ...entry, status: entry.status === 'KICKED' ? 'KICKED' : 'LEFT' }), status: 'LEFT' };
      participants.delete(socket.id);
      if (entry.admissionTicket) admissionTickets.delete(entry.admissionTicket);
      if (entry.role === 'PARTICIPANT') {
        io.to(hostRoom(code)).emit('participant-left', departed);
        emitParticipantList(code);
        emitLobbyUpdate(code);
      }
    });
  }

  function issueAdmissionTicket(entry) {
    if (entry.admissionTicket) admissionTickets.delete(entry.admissionTicket);
    const ticket = crypto.randomBytes(32).toString('hex');
    entry.admissionTicket = ticket;
    admissionTickets.set(ticket, { socketId: entry.socketId, code: entry.code, expiresAt: Date.now() + TICKET_TTL_MS });
    return ticket;
  }

  function validateAdmissionTicket(code, ticket) {
    if (typeof ticket !== 'string' || ticket.length !== 64) return false;
    const record = admissionTickets.get(ticket);
    return Boolean(record && record.code === code && record.expiresAt >= Date.now()
      && ['ADMITTED', 'MUTED'].includes(participants.get(record.socketId)?.status));
  }

  function consumeAdmissionTicket(code, ticket, identity) {
    if (!validateAdmissionTicket(code, ticket) || typeof identity !== 'string' || !identity.startsWith('student-')) {
      return false;
    }
    const record = admissionTickets.get(ticket);
    const entry = participants.get(record.socketId);
    if (!entry || entry.admissionTicket !== ticket) return false;
    admissionTickets.delete(ticket);
    entry.admissionTicket = null;
    entry.pendingLiveKitIdentity = identity;
    entry.liveKitIdentity = null;
    emitParticipantList(code);
    emitLobbyUpdate(code);
    return true;
  }

  io.on('connection', registerHandlers);

  return {
    participants,
    emitParticipantList,
    emitLobbyUpdate,
    notifyParticipant,
    validateAdmissionTicket,
    consumeAdmissionTicket
  };
}

module.exports = createParticipantsControl;
