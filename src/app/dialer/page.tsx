import { DialerShell } from "./components/DialerShell";

// Shell integration only — AppShell already renders the <main> landmark and the
// "Dialer" title, so this page contributes neither. Every dial control, pacing
// rule and compliance gate stays exactly where Agent B put it.
export default function DialerPage() {
  return <DialerShell />;
}
