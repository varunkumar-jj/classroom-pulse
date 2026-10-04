const LIVEKIT_CLIENT_URL = '/vendor/livekit-client/livekit-client.esm.mjs';

let liveKitRoom = null;
let liveKitClient = null;
let screenSharing = false;
let screenSharePending = false;
let screenShareTarget = false;
let microphoneEnabled = false;
let cameraEnabled = false;
let leavingRoom = false;
const participantTiles = new Map();
const attachedTracks = new Map();

function report(message, type = 'info') {
  window.classroomVideoConfig?.onState(message, type);
}

function updateConnectionStatus(label, state) {
  const badge = document.getElementById('videoConnectionStatus');
  if (!badge) return;
  badge.textContent = label;
  badge.classList.remove('connected', 'disconnected');
  if (state) badge.classList.add(state);
}

function updateVideoControls() {
  const micButton = document.getElementById('toggleMicBtn');
  const cameraButton = document.getElementById('toggleCamBtn');
  const screenButton = document.getElementById('shareScreenBtn');
  const leaveButton = document.getElementById('leaveVideoBtn');
  const controlsEnabled = Boolean(liveKitRoom && liveKitRoom.state === 'connected');
  if (micButton) micButton.disabled = !controlsEnabled;
  if (cameraButton) cameraButton.disabled = !controlsEnabled;
  if (screenButton) screenButton.disabled = !controlsEnabled || screenSharePending;
  if (leaveButton) leaveButton.disabled = !controlsEnabled;
  if (micButton) {
    micButton.innerHTML = `${microphoneEnabled ? '🎙️' : '🔇'} <span>${microphoneEnabled ? 'Mic On' : 'Mic Off'}</span>`;
    micButton.classList.toggle('active', !microphoneEnabled);
  }
  if (cameraButton) {
    cameraButton.innerHTML = `${cameraEnabled ? '📷' : '📵'} <span>${cameraEnabled ? 'Camera On' : 'Camera Off'}</span>`;
    cameraButton.classList.toggle('active', !cameraEnabled);
  }
  if (screenButton) {
    const label = screenSharePending
      ? (screenShareTarget ? 'Starting…' : 'Stopping…')
      : (screenSharing ? 'Stop sharing' : 'Share screen');
    screenButton.innerHTML = `🖥️ <span>${label}</span>`;
    screenButton.classList.toggle('active', screenSharing);
  }
}

function updateParticipantCount() {
  const badge = document.getElementById('videoPeerCount');
  if (!badge) return;
  const count = participantTiles.size;
  badge.textContent = `${count} participant${count === 1 ? '' : 's'}`;
}

function waitingTile(message) {
  const grid = document.getElementById('videoGrid');
  if (!grid || participantTiles.size) return;
  grid.innerHTML = `<div class="video-waiting"><div style="font-size:2rem;">📡</div><h3>${message}</h3></div>`;
}

function getParticipantTile(participant, isLocal = false) {
  const identity = participant.identity;
  if (participantTiles.has(identity)) return participantTiles.get(identity);

  const grid = document.getElementById('videoGrid');
  if (!grid) throw new Error('Video layout is unavailable.');
  if (!participantTiles.size) grid.innerHTML = '';

  const tile = document.createElement('div');
  tile.className = `video-tile${isLocal ? ' local' : ''}`;
  tile.dataset.identity = identity;
  const avatar = document.createElement('div');
  avatar.className = 'video-avatar';
  avatar.textContent = participant.name === 'Teacher' ? '👨‍🏫' : '👤';
  const media = document.createElement('div');
  media.className = 'video-media';
  const name = document.createElement('div');
  name.className = 'video-name';
  name.textContent = isLocal ? 'You' : (participant.name || 'Participant');
  const connection = document.createElement('span');
  connection.className = 'video-participant-state';
  connection.textContent = 'Connecting media';
  tile.append(avatar, media, name, connection);
  grid.appendChild(tile);
  const entry = { tile, avatar, media, connection, isLocal };
  participantTiles.set(identity, entry);
  updateParticipantCount();
  return entry;
}

function attachTrack(track, participant, isLocal = false) {
  if (track.kind === 'audio' && isLocal) return;
  const entry = getParticipantTile(participant, isLocal);
  const trackId = `${participant.identity}:${track.sid}`;
  if (attachedTracks.has(trackId)) return;

  const element = track.attach();
  if (track.kind === 'video') {
    element.autoplay = true;
    element.playsInline = true;
    element.dataset.screenShare = track.source === liveKitClient.Track.Source.ScreenShare ? 'true' : 'false';
    element.classList.add(track.source === liveKitClient.Track.Source.ScreenShare ? 'video-screen-track' : 'video-camera-track');
    if (isLocal) element.muted = true;
    entry.media.appendChild(element);
    entry.avatar.classList.add('hidden');
    if (track.source === liveKitClient.Track.Source.ScreenShare) entry.tile.classList.add('screen-sharing');
  } else {
    element.autoplay = true;
    element.className = 'video-audio-track';
    entry.media.appendChild(element);
  }
  attachedTracks.set(trackId, { element, entry, track });
  entry.connection.textContent = 'Connected';
}

function detachTrack(track, participant) {
  const trackId = `${participant.identity}:${track.sid}`;
  const attached = attachedTracks.get(trackId);
  if (!attached) return;
  track.detach(attached.element);
  attached.element.remove();
  attachedTracks.delete(trackId);
  const entry = participantTiles.get(participant.identity);
  if (entry && track.kind === 'video') {
    const hasVideo = [...entry.media.querySelectorAll('video')].length > 0;
    if (!hasVideo) entry.avatar.classList.remove('hidden');
    if (track.source === liveKitClient.Track.Source.ScreenShare) entry.tile.classList.remove('screen-sharing');
  }
}

function removeParticipant(participant) {
  const entry = participantTiles.get(participant.identity);
  if (!entry) return;
  for (const [trackId, attached] of attachedTracks) {
    if (attached.entry === entry) {
      attached.track.detach(attached.element);
      attached.element.remove();
      attachedTracks.delete(trackId);
    }
  }
  entry.tile.remove();
  participantTiles.delete(participant.identity);
  updateParticipantCount();
  waitingTile('Waiting for participants to join...');
}

function renderExistingTracks(participant, isLocal = false) {
  for (const publication of participant.trackPublications.values()) {
    if (publication.track) attachTrack(publication.track, participant, isLocal);
  }
}

async function fetchJoinToken(config) {
  const response = await fetch('/api/video/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: config.getCode(),
      role: config.role,
      name: config.getName(),
      teacherToken: config.role === 'teacher' ? config.getTeacherToken() : undefined
    })
  });
  let data;
  try {
    data = JSON.parse(await response.text());
  } catch {
    throw new Error(`Video authorization returned an invalid response (${response.status}).`);
  }
  if (!response.ok) throw new Error(data && typeof data.error === 'string' ? data.error : 'Could not authorize video room access.');
  if (!data || typeof data !== 'object'
    || typeof data.url !== 'string' || typeof data.token !== 'string' || !data.url || !data.token) {
    throw new Error('Video authorization did not return a room URL and access token.');
  }
  return data;
}

async function startVideoRoom() {
  if (liveKitRoom) return;
  const config = window.classroomVideoConfig;
  if (!config) throw new Error('Video room settings are unavailable.');

  const startButton = document.getElementById(config.role === 'teacher' ? 'videoRoomBtn' : 'joinVideoBtn');
  if (startButton) startButton.disabled = true;
  updateConnectionStatus('Authorizing', null);
  report('Connecting to the classroom video room...', 'info');

  try {
    const credentials = await fetchJoinToken(config);
    if (!liveKitClient) liveKitClient = await import(LIVEKIT_CLIENT_URL);
    const room = new liveKitClient.Room({ adaptiveStream: true, dynacast: true });
    liveKitRoom = room;
    leavingRoom = false;

    room.on(liveKitClient.RoomEvent.ParticipantConnected, (participant) => {
      getParticipantTile(participant);
    });
    room.on(liveKitClient.RoomEvent.ParticipantDisconnected, removeParticipant);
    room.on(liveKitClient.RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      attachTrack(track, participant);
    });
    room.on(liveKitClient.RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
      detachTrack(track, participant);
    });
    room.on(liveKitClient.RoomEvent.LocalTrackPublished, (publication, participant) => {
      if (publication.track) attachTrack(publication.track, participant, true);
    });
    room.on(liveKitClient.RoomEvent.LocalTrackUnpublished, (publication, participant) => {
      if (publication.track) detachTrack(publication.track, participant);
      if (publication.source === liveKitClient.Track.Source.ScreenShare) {
        screenSharing = false;
        screenSharePending = false;
        updateVideoControls();
      }
    });
    room.on(liveKitClient.RoomEvent.ConnectionStateChanged, (state) => {
      if (state === 'reconnecting') {
        updateConnectionStatus('Reconnecting', 'disconnected');
        report('Video connection interrupted; reconnecting...', 'info');
      } else if (state === 'connected') {
        updateConnectionStatus('Live', 'connected');
      }
      updateVideoControls();
    });
    room.on(liveKitClient.RoomEvent.Reconnecting, () => {
      updateConnectionStatus('Reconnecting', 'disconnected');
      report('Video connection interrupted; reconnecting...', 'info');
    });
    room.on(liveKitClient.RoomEvent.Reconnected, () => {
      updateConnectionStatus('Live', 'connected');
      report('Video connection restored.', 'success');
    });
    room.on(liveKitClient.RoomEvent.Disconnected, () => {
      if (!leavingRoom) {
        liveKitRoom = null;
        updateConnectionStatus('Disconnected', 'disconnected');
        report('Video room disconnected. Rejoin to continue.', 'error');
        finishVideoRoom();
      }
    });

    document.getElementById('videoRoom').classList.remove('hidden');
    const videoCode = document.getElementById('videoRoomCode');
    if (videoCode) videoCode.textContent = config.getCode();
    updateConnectionStatus('Connecting', null);
    await room.connect(credentials.url, credentials.token);
    getParticipantTile(room.localParticipant, true);
    for (const participant of room.remoteParticipants.values()) {
      getParticipantTile(participant);
      renderExistingTracks(participant);
    }
    updateConnectionStatus('Live', 'connected');

    const mediaWarnings = [];
    const canUseMedia = Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext;
    if (!canUseMedia) {
      mediaWarnings.push('Camera and microphone require HTTPS');
    }

    microphoneEnabled = canUseMedia && config.role === 'teacher';
    cameraEnabled = canUseMedia && config.role === 'teacher';
    if (canUseMedia && microphoneEnabled) {
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
      } catch (error) {
        microphoneEnabled = false;
        console.warn('Could not enable the LiveKit microphone.', error);
        mediaWarnings.push(`Microphone unavailable (${error?.name || 'device or permission error'})`);
      }
    }
    if (canUseMedia && cameraEnabled) {
      try {
        await room.localParticipant.setCameraEnabled(true);
      } catch (error) {
        cameraEnabled = false;
        console.warn('Could not enable the LiveKit camera.', error);
        mediaWarnings.push(`Camera unavailable (${error?.name || 'device or permission error'})`);
      }
    }
    updateVideoControls();
    if (startButton) startButton.textContent = config.role === 'teacher' ? '📹 Video Room Active' : '📹 In Video Room';
    report(mediaWarnings.length ? `${mediaWarnings.join(' and ')}; you can still join and watch.` : 'You joined the video room.', mediaWarnings.length ? 'info' : 'success');
  } catch (error) {
    if (liveKitRoom) {
      leavingRoom = true;
      await liveKitRoom.disconnect().catch(() => {});
      liveKitRoom = null;
    }
    finishVideoRoom();
    updateConnectionStatus('Unavailable', 'disconnected');
    throw error;
  }
}

function finishVideoRoom() {
  for (const entry of participantTiles.values()) entry.tile.remove();
  participantTiles.clear();
  attachedTracks.clear();
  const overlay = document.getElementById('videoRoom');
  if (overlay) overlay.classList.add('hidden');
  const config = window.classroomVideoConfig;
  const startButton = document.getElementById(config?.role === 'teacher' ? 'videoRoomBtn' : 'joinVideoBtn');
  if (startButton) {
    startButton.disabled = false;
    startButton.textContent = config?.role === 'teacher' ? '📹 Start Video Room' : '📹 Join Video';
  }
  screenSharing = false;
  screenSharePending = false;
  microphoneEnabled = false;
  cameraEnabled = false;
  updateVideoControls();
  updateParticipantCount();
  waitingTile('Waiting for participants to join...');
}

async function leaveVideoRoom() {
  if (!liveKitRoom) return;
  leavingRoom = true;
  const room = liveKitRoom;
  liveKitRoom = null;
  await room.disconnect();
  finishVideoRoom();
  updateConnectionStatus('Left room', null);
}

function withLiveRoom(action, onSuccess) {
  if (!liveKitRoom) return;
  const room = liveKitRoom;
  Promise.resolve().then(() => action(room.localParticipant)).then(() => {
    onSuccess();
  }).catch((error) => {
    updateVideoControls();
    console.error('Could not change a LiveKit media setting.', error);
    report(error.message || 'Could not change the video setting.', 'error');
  });
}

async function toggleScreenShare(nextState) {
  const room = liveKitRoom;
  if (!room || room.state !== 'connected' || screenSharePending) return;
  if (nextState && !window.isSecureContext) {
    screenSharing = false;
    updateVideoControls();
    report('Screen sharing requires this site to be opened over HTTPS.', 'error');
    return;
  }
  if (nextState && typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
    screenSharing = false;
    updateVideoControls();
    report('This browser or device does not support screen sharing. Use a desktop browser with display-capture support.', 'error');
    return;
  }

  screenSharePending = true;
  screenShareTarget = nextState;
  updateVideoControls();
  try {
    await room.localParticipant.setScreenShareEnabled(nextState, {
      audio: false,
      contentHint: 'detail'
    });
    if (liveKitRoom !== room) return;
    screenSharing = nextState;
  } catch (error) {
    if (liveKitRoom !== room) return;
    console.error(`Could not ${nextState ? 'start' : 'stop'} LiveKit screen sharing.`, error);
    report(screenShareErrorMessage(error), 'error');
  } finally {
    if (liveKitRoom === room) {
      screenSharePending = false;
      updateVideoControls();
    }
  }
}

function screenShareErrorMessage(error) {
  const reason = error?.name;
  if (reason === 'NotAllowedError' || reason === 'PermissionDeniedError') {
    return 'Screen sharing was cancelled or blocked. Allow screen capture in the browser prompt and try again.';
  }
  if (reason === 'NotFoundError') {
    return 'No screen, window, or browser tab is available to share.';
  }
  if (reason === 'NotReadableError' || reason === 'AbortError') {
    return 'The selected screen could not be captured. Close other capture apps and try again.';
  }
  if (reason === 'InvalidStateError') {
    return 'The browser requires screen sharing to start directly from a click. Click Share screen again while this tab is active.';
  }
  if (reason === 'NotSupportedError' || /not supported|not implemented/i.test(error?.message || '')) {
    return 'Screen sharing is unavailable in this browser or device. Use a supported desktop browser.';
  }
  return `Could not ${screenSharing ? 'stop' : 'start'} screen sharing${reason ? ` (${reason})` : ''}${error?.message ? `: ${error.message}` : '.'}`;
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const id = button.id;
  if (!['videoRoomBtn', 'joinVideoBtn', 'leaveVideoBtn', 'toggleMicBtn', 'toggleCamBtn', 'shareScreenBtn'].includes(id)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (id === 'videoRoomBtn' || id === 'joinVideoBtn') {
    if (liveKitRoom) return;
    startVideoRoom().catch((error) => {
      const config = window.classroomVideoConfig;
      const startButton = document.getElementById(config?.role === 'teacher' ? 'videoRoomBtn' : 'joinVideoBtn');
      if (startButton) startButton.disabled = false;
      updateConnectionStatus('Unavailable', 'disconnected');
      report(error.message || 'Could not start the video room.', 'error');
    });
  } else if (id === 'leaveVideoBtn') {
    await leaveVideoRoom();
  } else if (id === 'toggleMicBtn') {
    const nextState = !microphoneEnabled;
    withLiveRoom(
      (participant) => participant.setMicrophoneEnabled(nextState),
      () => {
        microphoneEnabled = nextState;
        updateVideoControls();
      }
    );
  } else if (id === 'toggleCamBtn') {
    const nextState = !cameraEnabled;
    withLiveRoom(
      (participant) => participant.setCameraEnabled(nextState),
      () => {
        cameraEnabled = nextState;
        updateVideoControls();
      }
    );
  } else if (id === 'shareScreenBtn') {
    await toggleScreenShare(!screenSharing);
  }
}, true);

window.addEventListener('pagehide', () => {
  if (liveKitRoom) liveKitRoom.disconnect();
});

updateVideoControls();
window.ClassroomVideo = { start: startVideoRoom, leave: leaveVideoRoom };
