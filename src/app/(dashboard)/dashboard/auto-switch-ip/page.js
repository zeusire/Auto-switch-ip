import AutoSwitchIpClient from "./AutoSwitchIpClient";

// Force dynamic so Next standalone build includes the server-side API routes
// this page depends on (same reason as console-log).
export const dynamic = "force-dynamic";

export default function AutoSwitchIpPage() {
  return <AutoSwitchIpClient />;
}
