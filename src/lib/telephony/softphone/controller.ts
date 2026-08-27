/**
 * Headless softphone controller. All Voice-SDK interaction goes through the
 * minimal `VoiceDeviceLike` / `VoiceCallLike` interfaces so the control logic is
 * unit-testable with a mocked WebRTC transport — no browser, no real Device.
 *
 * The React component (Softphone.tsx) is a thin shell around this class; the
 * device-smoke (real mic/audio) is the only part deferred to on-device testing.
 */

export interface VoiceCallLike {
  mute(shouldMute: boolean): void;
  disconnect(): void;
  sendDigits(digits: string): void;
  on?(event: string, handler: (...args: unknown[]) => void): void;
}

export interface VoiceDeviceLike {
  connect(opts: { params: Record<string, string> }): Promise<VoiceCallLike> | VoiceCallLike;
  on(event: string, handler: (...args: unknown[]) => void): void;
  register?(): Promise<void>;
}

export class SoftphoneController {
  private activeCall: VoiceCallLike | null = null;
  private muted = false;

  constructor(private readonly device: VoiceDeviceLike) {}

  /** Join the per-call conference room `conf_<callId>` (operator side). */
  async joinConference(callId: string): Promise<VoiceCallLike> {
    const call = await this.device.connect({ params: { conferenceName: `conf_${callId}` } });
    this.activeCall = call;
    this.muted = false;
    return call;
  }

  mute(): void {
    this.activeCall?.mute(true);
    this.muted = true;
  }

  unmute(): void {
    this.activeCall?.mute(false);
    this.muted = false;
  }

  toggleMute(): boolean {
    if (this.muted) this.unmute();
    else this.mute();
    return this.muted;
  }

  sendDigit(digit: string): void {
    this.activeCall?.sendDigits(digit);
  }

  hangup(): void {
    this.activeCall?.disconnect();
    this.activeCall = null;
    this.muted = false;
  }

  get isOnCall(): boolean {
    return this.activeCall !== null;
  }

  get isMuted(): boolean {
    return this.muted;
  }
}
