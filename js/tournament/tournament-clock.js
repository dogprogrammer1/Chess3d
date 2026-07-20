/* Tournament clock boundary. It owns elapsed-time accounting and reports only
 * state changes, leaving the UI and chess rules to the application layer. */
(function () {
  'use strict';

  class TournamentClock {
    constructor({ baseMs, incrementMs = 0, onTick = () => {}, onFlag = () => {} }) {
      this.baseMs = baseMs;
      this.incrementMs = incrementMs;
      this.onTick = onTick;
      this.onFlag = onFlag;
      this.remaining = { w: baseMs, b: baseMs };
      this.activeColor = null;
      this.lastTimestamp = 0;
      this.frame = null;
      this.flagged = false;
    }

    snapshot() {
      return {
        white: this.remaining.w,
        black: this.remaining.b,
        activeColor: this.activeColor,
        incrementMs: this.incrementMs,
        flagged: this.flagged
      };
    }

    reset() {
      this.stop(false);
      this.remaining = { w: this.baseMs, b: this.baseMs };
      this.flagged = false;
      this.onTick(this.snapshot());
    }

    sync({ white, black, activeColor = null, flagged = false }) {
      this.cancelFrame();
      this.activeColor = null;
      this.remaining = {
        w: Math.max(0, Number(white)),
        b: Math.max(0, Number(black))
      };
      this.flagged = Boolean(flagged);
      if (!this.flagged && ['w', 'b'].includes(activeColor) && this.remaining[activeColor] > 0) {
        this.activeColor = activeColor;
        this.lastTimestamp = performance.now();
      }
      this.onTick(this.snapshot());
      this.schedule();
    }

    start(color) {
      if (this.flagged || !['w', 'b'].includes(color)) return false;
      if (this.activeColor && this.activeColor !== color) this.stop(false);
      this.activeColor = color;
      this.lastTimestamp = performance.now();
      this.onTick(this.snapshot());
      this.schedule();
      return true;
    }

    press(color) {
      if (this.flagged || this.activeColor !== color) return false;
      this.update();
      if (this.flagged) return false;
      this.activeColor = null;
      this.remaining[color] += this.incrementMs;
      this.cancelFrame();
      this.onTick(this.snapshot());
      return true;
    }

    stop(notify = true) {
      if (this.activeColor && !this.flagged) this.update();
      this.activeColor = null;
      this.cancelFrame();
      if (notify) this.onTick(this.snapshot());
    }

    dispose() { this.stop(false); }

    update() {
      if (!this.activeColor || this.flagged) return;
      const now = performance.now();
      const elapsed = Math.max(0, now - this.lastTimestamp);
      this.lastTimestamp = now;
      const color = this.activeColor;
      this.remaining[color] = Math.max(0, this.remaining[color] - elapsed);
      if (this.remaining[color] === 0) {
        this.activeColor = null;
        this.flagged = true;
        this.cancelFrame();
        this.onTick(this.snapshot());
        this.onFlag(color);
        return;
      }
      this.onTick(this.snapshot());
    }

    schedule() {
      if (this.frame || !this.activeColor || this.flagged) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        this.update();
        this.schedule();
      });
    }

    cancelFrame() {
      if (!this.frame) return;
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
  }

  window.TournamentTiming = { TournamentClock };
})();
