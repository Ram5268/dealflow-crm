import { describe, it, expect, vi } from "vitest";
import {
  SoftphoneController,
  type VoiceDeviceLike,
  type VoiceCallLike,
} from "@/lib/telephony/softphone/controller";

function mockCall() {
  return { mute: vi.fn(), disconnect: vi.fn(), sendDigits: vi.fn() };
}

function mockDevice(call: VoiceCallLike) {
  return { connect: vi.fn().mockResolvedValue(call), on: vi.fn() };
}

describe("SoftphoneController (mocked WebRTC transport)", () => {
  it("joinConference connects with params.conferenceName = conf_<callId>", async () => {
    const call = mockCall();
    const device = mockDevice(call);
    const c = new SoftphoneController(device);
    await c.joinConference("call_abc123");
    expect(device.connect).toHaveBeenCalledWith({ params: { conferenceName: "conf_call_abc123" } });
    expect(c.isOnCall).toBe(true);
    expect(c.isMuted).toBe(false);
  });

  it("mute / unmute drive call.mute and track state", async () => {
    const call = mockCall();
    const c = new SoftphoneController(mockDevice(call));
    await c.joinConference("call_1");
    c.mute();
    expect(call.mute).toHaveBeenLastCalledWith(true);
    expect(c.isMuted).toBe(true);
    c.unmute();
    expect(call.mute).toHaveBeenLastCalledWith(false);
    expect(c.isMuted).toBe(false);
  });

  it("toggleMute flips and returns the new state", async () => {
    const call = mockCall();
    const c = new SoftphoneController(mockDevice(call));
    await c.joinConference("call_1");
    expect(c.toggleMute()).toBe(true);
    expect(call.mute).toHaveBeenLastCalledWith(true);
    expect(c.toggleMute()).toBe(false);
    expect(call.mute).toHaveBeenLastCalledWith(false);
  });

  it("sendDigit forwards DTMF to the active call", async () => {
    const call = mockCall();
    const c = new SoftphoneController(mockDevice(call));
    await c.joinConference("call_1");
    c.sendDigit("5");
    expect(call.sendDigits).toHaveBeenCalledWith("5");
  });

  it("hangup disconnects and clears state", async () => {
    const call = mockCall();
    const c = new SoftphoneController(mockDevice(call));
    await c.joinConference("call_1");
    c.hangup();
    expect(call.disconnect).toHaveBeenCalled();
    expect(c.isOnCall).toBe(false);
  });

  it("controls are no-ops with no active call (never throws)", () => {
    const c = new SoftphoneController(mockDevice(mockCall()));
    expect(() => {
      c.mute();
      c.unmute();
      c.sendDigit("1");
      c.hangup();
    }).not.toThrow();
    expect(c.isOnCall).toBe(false);
  });
});
