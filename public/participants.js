(() => {
  'use strict';

  // Works both as a standalone page and embedded in the teacher dashboard.
  // When embedded, teacher.html hands over its existing socket and credentials
  // so we never open a second connection or fight over the video globals.
  const hostConfig = window.ParticipantsManagerConfig || null;
  const params = new URLSearchParams(window.location.search);
  const roomCode = (hostConfig?.roomCode || params.get('room') || '').trim().toUpperCase();
  const teacherToken = hostConfig?.teacherToken
    || new URLSearchParams(window.location.hash.slice(1)).get('token')
    || params.get('token')
    || '';
  const socket = hostConfig?.socket || io();
  const state = { authenticated: false, participants: [], pendingKick: null };
  const lobbyList = document.getElementById('lobbyList');
  const liveList = document.getElementById('liveList');
  const kickDialog = document.getElementById('kickDialog');

  // Optional elements are absent depending on which page is hosting us, so
  // every one of them is looked up defensively rather than at load time.
  const byId = (id) => document.getElementById(id);
  const setText = (id, value) => { const node = byId(id); if (node) node.textContent = value; };

  window.classroomSocket = socket;
  // On the standalone page this script owns the video globals. Inside the
  // teacher dashboard teacher.html has already configured them, and
  // overwriting here would break the teacher's own video room.
  if (!hostConfig && !window.classroomVideoConfig) {
    window.classroomVideoConfig = {
      role: 'teacher',
      getCode: () => roomCode,
      getTeacherToken: () => teacherToken,
      getName: () => 'Teacher',
      onState: (message, type) => showToast(message, type === 'error' ? 'error' : 'success')
    };
  }

  function showError(message) {
    const region = byId('managerError');
    if (!region) return;
    region.textContent = message;
    region.classList.remove('hidden');
  }

  function showToast(message, type = 'success') {
    const region = byId('toastRegion');
    if (!region) return;
    const toast = document.createElement('div');
    toast.className = `manager-toast ${type === 'error' ? 'error' : ''}`;
    toast.textContent = message;
    region.appendChild(toast);
    window.setTimeout(() => toast.remove(), 3600);
  }

  function emitAck(event, payload) {
    return new Promise((resolve, reject) => {
      socket.timeout(5000).emit(event, payload, (timeoutError, response) => {
        if (timeoutError) return reject(new Error('The classroom server did not respond. Try again.'));
        if (!response?.ok) return reject(new Error(response?.err || 'The action could not be completed.'));
        resolve(response);
      });
    });
  }

  function participantCard(participant, inLiveRoom) {
    const card = document.createElement('article');
    card.className = 'participant-card';

    const identity = document.createElement('div');
    identity.className = 'participant-identity';
    const avatar = document.createElement('span');
    avatar.className = 'participant-avatar';
    avatar.textContent = (participant.name || '?').trim().slice(0, 1).toUpperCase();
    const details = document.createElement('div');
    const name = document.createElement('strong');
    name.className = 'participant-name';
    name.textContent = participant.name || 'Participant';
    const time = document.createElement('span');
    time.className = 'participant-time';
    time.textContent = `Joined ${new Date(participant.joinedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    details.append(name, time);
    identity.append(avatar, details);

    const status = document.createElement('span');
    status.className = `status-pill status-${participant.status.toLowerCase()}`;
    status.textContent = participant.status === 'MUTED' ? 'Muted' : (inLiveRoom ? 'In class' : 'Waiting');

    const actions = document.createElement('div');
    actions.className = 'participant-actions';
    if (inLiveRoom) {
      const mute = document.createElement('button');
      mute.type = 'button';
      mute.className = 'action-button';
      mute.textContent = participant.status === 'MUTED' ? 'Allow mic' : 'Mute';
      mute.addEventListener('click', () => muteParticipant(participant));
      actions.appendChild(mute);
    } else {
      const admit = document.createElement('button');
      admit.type = 'button';
      admit.className = 'action-button admit-button';
      admit.textContent = '✓ Admit';
      admit.addEventListener('click', () => runAction(async () => {
        await emitAck('admit-participant', { code: roomCode, participantId: participant.id });
        const videoTab = byId('tab-live');
        if (videoTab) activateTab(videoTab, false);
        showToast(`${participant.name} was admitted and moved to the video room.`);
      }));
      actions.appendChild(admit);
    }

    const kick = document.createElement('button');
    kick.type = 'button';
    kick.className = 'action-button kick-button';
    kick.textContent = 'Kick';
    kick.addEventListener('click', () => openKickDialog(participant));
    actions.appendChild(kick);
    card.append(identity, status, actions);
    return card;
  }

  function renderParticipants(payload) {
    // The server sends two independent lists; never merge them, or a student
    // would appear in both the normal room and the video room at once.
    const rooms = payload || {};
    const mainRoom = (rooms.mainRoom || []).filter((participant) => participant.role === 'PARTICIPANT');
    const videoRoom = (rooms.videoRoom || []).filter((participant) => participant.role === 'PARTICIPANT');
    state.participants = [...mainRoom, ...videoRoom];

    const total = mainRoom.length + videoRoom.length;
    setText('totalCount', String(total));
    setText('liveCount', String(videoRoom.length));
    setText('waitingCount', String(mainRoom.length));
    setText('lobbyTabCount', String(mainRoom.length));
    setText('liveTabCount', String(videoRoom.length));
    setText('waitingSummary', mainRoom.length + ' in the normal room');
    setText('liveSummary', videoRoom.length + ' in the video room');
    setText('liveSideCount', videoRoom.length + ' student' + (videoRoom.length === 1 ? '' : 's'));

    lobbyList?.replaceChildren();
    liveList?.replaceChildren();
    if (!mainRoom.length && lobbyList) lobbyList.appendChild(emptyState('No one is in the normal room yet.'));
    const liveEmpty = byId('liveEmpty');
    if (liveEmpty) liveEmpty.hidden = videoRoom.length > 0;
    const videoPlaceholder = byId('liveVideoPlaceholder');
    if (videoPlaceholder) videoPlaceholder.classList.toggle('hidden', videoRoom.length > 0);
    const preview = byId('livePreviewEmpty');
    if (preview) {
      preview.innerHTML = videoRoom.length
        ? '<span class="manager-preview-icon"><i class="icon-user-round" aria-hidden="true"></i></span><p><strong>' + videoRoom.length + ' student' + (videoRoom.length === 1 ? '' : 's') + ' in video</strong>They will appear here when they join video.</p>'
        : '<span class="manager-preview-icon"><i class="icon-video" aria-hidden="true"></i></span><p><strong>No one admitted yet</strong>Students you admit appear here automatically.</p>';
    }
    mainRoom.forEach((participant) => lobbyList?.appendChild(participantCard(participant, false)));
    videoRoom.forEach((participant) => liveList?.appendChild(participantCard(participant, true)));
    attachVideoTileControls();

    const recipient = byId('chatRecipient');
    if (!recipient) return;
    const selected = recipient.value;
    recipient.replaceChildren(new Option('Everyone in class', ''));
    state.participants.forEach((participant) => {
      recipient.add(new Option(participant.name, participant.id));
    });
    if (state.participants.some((participant) => participant.id === selected)) recipient.value = selected;
  }
  function emptyState(message) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = message;
    return empty;
  }

  async function runAction(action) {
    try {
      await action();
    } catch (error) {
      showToast(error.message || 'The action could not be completed.', 'error');
    }
  }

  function openKickDialog(participant) {
    state.pendingKick = participant;
    if (!kickDialog) return;
    setText('kickTargetLabel', `Remove ${participant.name} from this classroom?`);
    const reason = byId('kickReason');
    if (reason) reason.value = '';
    setText('kickError', '');
    kickDialog.showModal();
    reason?.focus();
  }

  function muteParticipant(participant) {
    runAction(async () => {
      const muted = participant.status !== 'MUTED';
      await emitAck('mute-participant', { code: roomCode, participantId: participant.id, muted });
      showToast(muted ? `${participant.name} was muted.` : `${participant.name} may speak.`);
    });
  }

  function attachVideoTileControls() {
    const grid = document.getElementById('videoGrid');
    if (!grid) return;
    grid.querySelectorAll('.video-tile[data-identity]').forEach((tile) => {
      const participant = state.participants.find((item) => item.videoIdentity === tile.dataset.identity);
      if (!participant) return;
      let controls = tile.querySelector('.manager-tile-controls');
      if (!controls) {
        controls = document.createElement('div');
        controls.className = 'manager-tile-controls';
        tile.appendChild(controls);
      }
      controls.replaceChildren();
      const mute = document.createElement('button');
      mute.type = 'button';
      mute.className = 'action-button';
      mute.textContent = participant.status === 'MUTED' ? 'Allow mic' : 'Mute';
      mute.addEventListener('click', (event) => {
        event.stopPropagation();
        muteParticipant(participant);
      });
      const kick = document.createElement('button');
      kick.type = 'button';
      kick.className = 'action-button kick-button';
      kick.textContent = 'Kick';
      kick.addEventListener('click', (event) => {
        event.stopPropagation();
        openKickDialog(participant);
      });
      controls.append(mute, kick);
    });
  }

  function addChatMessage(item, isPrivate = false) {
    const message = document.createElement('article');
    message.className = `chat-message${isPrivate ? ' private-message' : ''}`;
    const metadata = document.createElement('div');
    metadata.className = 'chat-message-meta';
    const sender = document.createElement('strong');
    sender.textContent = isPrivate ? `${item.from} · Private` : item.from;
    const time = document.createElement('time');
    time.dateTime = new Date(item.timestamp).toISOString();
    time.textContent = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const body = document.createElement('p');
    body.textContent = item.message;
    metadata.append(sender, time);
    message.append(metadata, body);
    const messages = byId('chatMessages');
    if (!messages) return;
    byId('chatEmpty')?.remove();
    messages.appendChild(message);
    messages.scrollTop = messages.scrollHeight;
  }

  async function authenticateHost() {
    if (!roomCode || !teacherToken) {
      showError('Open this panel using the Participants button in your authenticated teacher dashboard.');
      return;
    }
    try {
      const response = await emitAck('host-join', { code: roomCode, token: teacherToken });
      state.authenticated = true;
      setText('roomLabel', `Room ${roomCode} · Host connected`);
      const backLink = byId('managerBackLink');
      if (backLink) backLink.href = `/teacher.html?room=${encodeURIComponent(roomCode)}#token=${encodeURIComponent(teacherToken)}`;
      renderParticipants(response.participants || {});
      await emitAck('request-participant-list', { code: roomCode });
    } catch (error) {
      showError(error.message);
    }
  }

  const managerTabs = [...document.querySelectorAll('.manager-tab')];

  function startManagerVideo() {
    const overlay = byId('videoRoom');
    if (overlay) overlay.classList.remove('hidden');
    setText('videoConnectionStatus', 'Connecting…');
    // The teacher dashboard already owns its own video room and start button,
    // so embedded we must not start a second LiveKit connection here.
    if (!window.ClassroomVideo || hostConfig) return;
    window.ClassroomVideo.start().then(() => {
      byId('liveVideoPlaceholder')?.classList.add('hidden');
    }).catch((error) => {
      setText('videoConnectionStatus', 'Unavailable');
      byId('liveVideoPlaceholder')?.classList.remove('hidden');
      showToast(error.message || 'Video could not be started.', 'error');
    });
  }

  function activateTab(tab, connectVideo = true) {
    managerTabs.forEach((item) => {
      const active = item === tab;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll('.manager-channel').forEach((channel) => {
      channel.classList.toggle('active', channel.id === `channel-${tab.dataset.channel}`);
    });
    if (tab.dataset.channel === 'live' && connectVideo && !hostConfig) startManagerVideo();
  }

  managerTabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activateTab(tab));
    tab.addEventListener('keydown', (event) => {
      let nextIndex = index;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % managerTabs.length;
      else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + managerTabs.length) % managerTabs.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = managerTabs.length - 1;
      else return;
      event.preventDefault();
      managerTabs[nextIndex].focus();
      activateTab(managerTabs[nextIndex]);
    });
  });

  window.addEventListener('classroom-video-ready', () => {
    if (hostConfig) return;
    if (byId('channel-live')?.classList.contains('active')) startManagerVideo();
  });

  const videoGrid = byId('videoGrid');
  if (videoGrid) {
    // Overlays Mute/Kick onto live LiveKit tiles wherever the video grid lives.
    new MutationObserver(attachVideoTileControls).observe(videoGrid, { childList: true });
  }

  // Only the standalone page owns these buttons; the teacher dashboard wires
  // its own video controls.
  if (!hostConfig) {
    byId('videoRoomBtn')?.addEventListener('click', startManagerVideo);
    byId('stageConnect')?.addEventListener('click', startManagerVideo);
  }
  byId('closeKickDialog')?.addEventListener('click', () => kickDialog?.close());
  byId('cancelKickBtn')?.addEventListener('click', () => kickDialog?.close());
  byId('kickForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const participant = state.pendingKick;
    const reason = byId('kickReason')?.value.trim() || '';
    if (!participant) return;
    if (reason.length < 3) {
      setText('kickError', 'Enter a reason of at least 3 characters.');
      byId('kickReason').focus();
      return;
    }
    kickDialog?.close();
    runAction(async () => {
      await emitAck('kick-participant', { code: roomCode, participantId: participant.id, reason });
      showToast(`${participant.name} was removed from the classroom.`);
      state.pendingKick = null;
    });
  });

  byId('chatForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = byId('chatInput');
    const message = input.value.trim();
    if (!message || !state.authenticated) return;
    const recipientId = byId('chatRecipient').value;
    const eventName = recipientId ? 'private-chat-message' : 'classroom-message';
    const payload = recipientId
      ? { code: roomCode, participantId: recipientId, message }
      : { code: roomCode, message };
    runAction(async () => {
      await emitAck(eventName, payload);
      input.value = '';
    });
  });

  socket.on('connect', authenticateHost);
  socket.on('connect_error', () => showError('Could not connect to the classroom server.'));
  socket.on('participant-list', renderParticipants);
  socket.on('lobby-update', renderParticipants);
  socket.on('participant-left', (participant) => {
    if (participant?.name) showToast(`${participant.name} left the classroom.`);
  });
  socket.on('classroom-message', (item) => addChatMessage(item));
  socket.on('private-chat-message', (item) => addChatMessage(item, true));
})();
