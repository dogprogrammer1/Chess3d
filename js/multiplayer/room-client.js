/* Small WebSocket client for LAN tournament rooms. The relay only forwards
 * match messages; chess rules and clock behavior remain in the browser. */
(function () {
  'use strict';

  const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const ROOM_LENGTH = 6;
  const MESSAGE_VERSION = 1;

  function normalizeRoom(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, ROOM_LENGTH);
  }

  function createRoomCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(ROOM_LENGTH));
    return Array.from(bytes, byte => ROOM_ALPHABET[byte % ROOM_ALPHABET.length]).join('');
  }

  class RoomClient {
    constructor({ onStatus = () => {}, onMessage = () => {} } = {}) {
      this.onStatus = onStatus;
      this.onMessage = onMessage;
      this.socket = null;
      this.room = '';
      this.role = null;
      this.status = 'idle';
    }

    emit(status, detail = '') {
      this.status = status;
      this.onStatus(status, detail);
    }

    connect(room, role) {
      this.close(false);
      this.room = normalizeRoom(room);
      this.role = role;
      if (this.room.length !== ROOM_LENGTH) return Promise.reject(new Error('Enter the full six-character room code.'));
      if (!['host', 'guest'].includes(role)) return Promise.reject(new Error('Choose whether to create or join the match.'));

      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${protocol}//${location.hostname}:8766/`;
      this.emit('connecting', 'Connecting to the local tournament relay…');
      return new Promise((resolve, reject) => {
        let settled = false;
        const socket = new WebSocket(url);
        this.socket = socket;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          socket.close();
          this.emit('failed', 'The tournament relay did not answer.');
          reject(new Error('Start Tournament Room with network play enabled, then try again.'));
        }, 4_000);

        socket.addEventListener('open', () => {
          socket.send(JSON.stringify({ type: 'join', room: this.room, role }));
        });
        socket.addEventListener('message', event => {
          let message;
          try { message = JSON.parse(event.data); } catch { return; }
          if (message.type === 'room-state') {
            if (message.error) {
              clearTimeout(timer);
              if (!settled) { settled = true; reject(new Error(message.error)); }
              this.emit('failed', message.error);
              return;
            }
            if (message.ready) this.emit('connected', 'Both devices are connected.');
            else this.emit('waiting', role === 'host' ? 'Room ready. Waiting for the other device…' : 'Waiting for the host…');
            if (!settled) { settled = true; clearTimeout(timer); resolve(message); }
            if (message.ready) this.onMessage('room-ready', message);
            return;
          }
          if (message.type === 'peer-left') {
            this.emit('disconnected', 'The other device left the room.');
            this.onMessage('peer-left', {});
            return;
          }
          if (message.version === MESSAGE_VERSION && typeof message.type === 'string') {
            this.onMessage(message.type, message.payload || {});
          }
        });
        socket.addEventListener('error', () => {
          clearTimeout(timer);
          if (!settled) { settled = true; reject(new Error('Could not reach the local tournament relay.')); }
          this.emit('failed', 'Could not reach the local tournament relay.');
        });
        socket.addEventListener('close', () => {
          clearTimeout(timer);
          if (this.status !== 'idle' && this.status !== 'failed') this.emit('disconnected', 'Tournament room connection closed.');
        });
      });
    }

    send(type, payload = {}) {
      if (this.socket?.readyState !== WebSocket.OPEN) return false;
      this.socket.send(JSON.stringify({ version: MESSAGE_VERSION, type, payload }));
      return true;
    }

    close(notify = true) {
      const socket = this.socket;
      this.socket = null;
      this.room = '';
      this.role = null;
      this.status = 'idle';
      try { socket?.close(); } catch { /* Already closed. */ }
      if (notify) this.onStatus('closed', 'Tournament room connection closed.');
    }
  }

  window.TournamentMultiplayer = { RoomClient, createRoomCode, normalizeRoom };
})();
