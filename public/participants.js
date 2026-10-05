(() => {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const roomCode = (params.get('room') || '').trim().toUpperCase();
  const teacherToken = new URLSearchParams(window.location.hash.slice(1)).get('token')
    || params.get('token')
    || '';
  const socket = io();
  const state = { authenticated: false, participants: [], pendingKick: null };
  const lobbyList = document.getElementById('lobbyList');
  const liveList = document.getElementById('liveList');
  const kickDialog = document.getElementById('kickDialog');

  window.classroomSocket = socket;
  window.classroomVideoConfig = {
    role: 'teacher',
    getCode: () => roomCode,
    getTeacherToken: () => teacherToken,
    getName: () => 'Teacher',
    onState: (message, type) => showToast(message, type === 'error' ? 'error' : 'success')
  };

  function showError(message) {
    const region = document.getElementById('managerError');
    region.textContent = message;
    region.classList.remove('hidden');
  }

  function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `manager-toast ${type === 'error' ? 'error' : ''}`;
    toast.textContent = message;
    document.getElementById('toastRegion').appendChild(toast);
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
        activateTab(document.getElementById('tab-live'), false);
        showToast(`${participant.name} was admitted and moved to Live class.`);
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
    document.getElementById('totalCount').textContent = String(total);
    document.getElementById('liveCount').textContent = String(videoRoom.length);
    document.getElementById('waitingCount').textContent = String(mainRoom.length);
    document.getElementById('lobbyTabCount').textContent = String(mainRoom.length);
    document.getElementById('liveTabCount').textContent = String(videoRoom.length);
    document.getElementById('waitingSummary').textContent = mainRoom.length + ' in the normal room';
    document.getElementById('liveSummary').textContent = videoRoom.length + ' in the video room';
    document.getElementById('liveSideCount').textContent = videoRoom.length + ' student' + (videoRoom.length === 1 ? '' : 's');

    lobbyList.replaceChildren();
    liveList.replaceChildren();
    if (!mainRoom.length) lobbyList.appendChild(emptyState('No one is in the normal room yet.'));
    document.getElementById('liveEmpty').hidden = videoRoom.length > 0;
    document.getElementById('liveVideoPlaceholder').classList.toggle('hidden', videoRoom.length > 0);
    document.getElementById('livePreviewEmpty').innerHTML = videoRoom.length
      ? '<span class="manager-preview-icon"><i class="icon-user-round" aria-hidden="true"></i></span><p><strong>' + videoRoom.length + ' student' + (videoRoom.length === 1 ? '' : 's') + ' in video</strong>They will appear here when they join video.</p>'
      : '<span class="manager-preview-icon"><i class="icon-video" aria-hidden="true"></i></span><p><strong>No one admitted yet</strong>Students you admit appear here automatically.</p>';
    mainRoom.forEach((participant) => lobbyList.appendChild(participantCard(participant, false)));
    videoRoom.forEach((participant) => liveList.appendChild(participantCard(participant, true)));
    attachVideoTileControls();

    const recipient = document.getElementById('chatRecipient');
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
    document.getElementById('kickTargetLabel').textContent = `Remove ${participant.name} from this classroom?`;
    document.getElementById('kickReason').value = '';
    document.getElementById('kickError').textContent = '';
    kickDialog.showModal();
    document.getElementById('kickReason').focus();
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
    const messages = document.getElementById('chatMessages');
    document.getElementById('chatEmpty')?.remove();
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
      document.getElementById('roomLabel').textContent = `Room ${roomCode} · Host connected`;
      document.getElementById('managerBackLink').href = `/teacher.html?room=${encodeURIComponent(roomCode)}#token=${encodeURIComponent(teacherToken)}`;
      renderParticipants(response.participants || []);
      await emitAck('request-participant-list', { code: roomCode });
    } catch (error) {
      showError(error.message);
    }
  }

  const managerTabs = [...document.querySelectorAll('.manager-tab')];

  function startManagerVideo() {
    document.getElementById('videoRoom').classList.remove('hidden');
    document.getElementById('videoConnectionStatus').textContent = 'Connecting…';
    if (!window.ClassroomVideo) return;
    window.ClassroomVideo.start().then(() => {
      document.getElementById('liveVideoPlaceholder').classList.add('hidden');
    }).catch((error) => {
      document.getElementById('videoConnectionStatus').textContent = 'Unavailable';
      document.getElementById('liveVideoPlaceholder').classList.remove('hidden');
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
    if (tab.dataset.channel === 'live' && connectVideo) startManagerVideo();
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
    if (document.getElementById('channel-live').classList.contains('active')) startManagerVideo();
  });

  const videoGridObserver = new MutationObserver(attachVideoTileControls);
  videoGridObserver.observe(document.getElementById('videoGrid'), { childList: true });

  document.getElementById('videoRoomBtn').addEventListener('click', startManagerVideo);
  document.getElementById('stageConnect').addEventListener('click', startManagerVideo);
  document.getElementById('closeKickDialog').addEventListener('click', () => kickDialog.close());
  document.getElementById('cancelKickBtn').addEventListener('click', () => kickDialog.close());
  document.getElementById('kickForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const participant = state.pendingKick;
      const reason = document.getElementById('kickReason').value.trim();
      if (!participant) return;
      if (reason.length < 3) {
        document.getElementById('kickError').textContent = 'Enter a reason of at least 3 characters.';
        document.getElementById('kickReason').focus();
        return;
      }
      kickDialog.close();
    runAction(async () => {
      await emitAck('kick-participant', { code: roomCode, participantId: participant.id, reason });
      showToast(`${participant.name} was removed from the classroom.`);
      state.pendingKick = null;
    });
  });

  document.getElementById('chatForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.getElementById('chatInput');
    const message = input.value.trim();
    if (!message || !state.authenticated) return;
    const recipientId = document.getElementById('chatRecipient').value;
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
