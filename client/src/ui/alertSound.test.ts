import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BEEP_MIN_GAP_MS,
  playAlertSound,
  resetAlertSoundForTest,
} from './alertSound';
import { DEFAULT_SETTINGS, normalizeSettings } from './settings';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeParam {
  events: string[] = [];
  setValueAtTime(v: number, t: number): void {
    this.events.push(`set:${v}@${t}`);
  }
  exponentialRampToValueAtTime(v: number, t: number): void {
    this.events.push(`ramp:${v}@${t}`);
  }
}

class FakeOscillator {
  type = '';
  frequency = new FakeParam();
  started: number[] = [];
  stopped: number[] = [];
  connect = vi.fn();
  start = (t: number): void => {
    this.started.push(t);
  };
  stop = (t: number): void => {
    this.stopped.push(t);
  };
}

class FakeGain {
  gain = new FakeParam();
  connect = vi.fn();
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static initialState = 'running';
  currentTime = 1;
  state: string;
  destination = {};
  oscillators: FakeOscillator[] = [];
  gains: FakeGain[] = [];
  resume = vi.fn(async (): Promise<void> => {});

  constructor() {
    this.state = FakeAudioContext.initialState;
    FakeAudioContext.instances.push(this);
  }

  createOscillator(): FakeOscillator {
    const osc = new FakeOscillator();
    this.oscillators.push(osc);
    return osc;
  }

  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
}

type WindowWithAudio = { AudioContext?: unknown };

beforeEach(() => {
  FakeAudioContext.instances = [];
  FakeAudioContext.initialState = 'running';
  (window as unknown as WindowWithAudio).AudioContext = FakeAudioContext;
  resetAlertSoundForTest();
});

afterEach(() => {
  resetAlertSoundForTest();
  delete (window as unknown as WindowWithAudio).AudioContext;
});

describe('playAlertSound', () => {
  it('schedules a short two-tone chime on a lazily created context', () => {
    expect(FakeAudioContext.instances).toHaveLength(0); // no context before the first beep
    expect(playAlertSound(1_000)).toBe(true);
    const ctx = FakeAudioContext.instances[0];
    expect(ctx.oscillators).toHaveLength(2);
    expect(ctx.oscillators[0].frequency.events[0]).toContain('880');
    expect(ctx.oscillators[1].frequency.events[0]).toContain('1318.5');
    // Quiet envelope: attack from the floor, exponential decay back to it.
    expect(ctx.gains[0].gain.events.some((e) => e.startsWith('ramp:0.0001'))).toBe(true);
    // The second tone starts after the first, both stop after they start.
    expect(ctx.oscillators[1].started[0]).toBeGreaterThan(ctx.oscillators[0].started[0]);
    expect(ctx.oscillators[0].stopped[0]).toBeGreaterThan(ctx.oscillators[0].started[0]);
  });

  it('rate-limits bursts to one chime per BEEP_MIN_GAP_MS', () => {
    expect(playAlertSound(10_000)).toBe(true);
    expect(playAlertSound(10_100)).toBe(false);
    expect(playAlertSound(10_000 + BEEP_MIN_GAP_MS - 1)).toBe(false);
    expect(playAlertSound(10_000 + BEEP_MIN_GAP_MS)).toBe(true);
    expect(FakeAudioContext.instances[0].oscillators).toHaveLength(4); // two tones × two chimes
  });

  it('resumes a suspended context and re-resumes it on the next user gesture', () => {
    FakeAudioContext.initialState = 'suspended';
    expect(playAlertSound(20_000)).toBe(true);
    const ctx = FakeAudioContext.instances[0];
    expect(ctx.state).toBe('suspended');
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    // The gesture listener fires once and detaches itself.
    window.dispatchEvent(new Event('pointerdown'));
    expect(ctx.resume).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event('pointerdown'));
    expect(ctx.resume).toHaveBeenCalledTimes(2);
  });

  it('is silent (and never throws) when the environment has no AudioContext', () => {
    delete (window as unknown as WindowWithAudio).AudioContext;
    expect(playAlertSound(30_000)).toBe(false);
    expect(() => playAlertSound(30_100)).not.toThrow();
  });
});

describe('alertSound setting (P3)', () => {
  it('defaults to on and normalizes junk to the default', () => {
    expect(DEFAULT_SETTINGS.alertSound).toBe(true);
    expect(normalizeSettings({}).alertSound).toBe(true); // pre-upgrade payload adopts it
    expect(normalizeSettings({ alertSound: false }).alertSound).toBe(false);
    expect(normalizeSettings({ alertSound: 'yes' }).alertSound).toBe(true);
    expect(normalizeSettings({ alertSound: 0 }).alertSound).toBe(true);
  });
});
