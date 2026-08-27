import { describe, it, expect } from "vitest";
import {
  buildConferenceTwiml,
  buildOperatorConferenceTwiml,
  buildPauseTwiml,
  buildHangupTwiml,
} from "@/lib/telephony/twilio/twiml";

describe("conference-bridge TwiML fixtures", () => {
  it("callee side dials into conf_<callId>, endConferenceOnExit=false", () => {
    expect(buildConferenceTwiml("call_abc")).toBe(
      '<Response><Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="false">conf_call_abc</Conference></Dial></Response>',
    );
  });

  it("operator side joins the given room, endConferenceOnExit=true", () => {
    expect(buildOperatorConferenceTwiml("conf_call_abc")).toBe(
      '<Response><Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="true">conf_call_abc</Conference></Dial></Response>',
    );
  });

  it("pause + hangup fixtures", () => {
    expect(buildPauseTwiml(30)).toBe('<Response><Pause length="30"/></Response>');
    expect(buildPauseTwiml()).toBe('<Response><Pause length="30"/></Response>');
    expect(buildHangupTwiml()).toBe("<Response><Hangup/></Response>");
  });
});
