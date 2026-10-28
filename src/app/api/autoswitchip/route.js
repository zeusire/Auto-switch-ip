import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/db/index.js";
import {
  getEngineStatus,
  startEngine,
  stopEngine,
  checkPython,
  provisionBinaries,
} from "@/lib/autoswitchip/engine";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE = { "Cache-Control": "no-store" };
const SETTINGS_KEY = "autoSwitchIp";

// GET /api/autoswitchip — current toggle + process state
export async function GET() {
  try {
    const settings = await getSettings();
    return NextResponse.json(getEngineStatus(settings), { headers: NO_STORE });
  } catch (error) {
    console.log("Error reading auto-switch-ip state:", error);
    return NextResponse.json({ error: "Failed to read state" }, { status: 500 });
  }
}

/**
 * PATCH /api/autoswitchip — { enabled: boolean }
 *
 * The toggle is persisted *and* applied: enabling provisions the host (Python
 * with `requests`/`yaml`, then sing-box and usque) and spawns the engine;
 * disabling stops it. Persisting first means a crash between the two still
 * leaves the user's intent recorded, and the next server boot reconciles it
 * (see initializeApp).
 *
 * Provisioning runs here rather than at image build time because the release
 * CDN is not reachable from every build sandbox, and because the Windows app
 * has no install step at all.
 */
export async function PATCH(request) {
  try {
    const body = await request.json();
    if (typeof body?.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
    }

    const settings = await getSettings();
    const current = settings?.[SETTINGS_KEY] || {};
    const next = { ...current, enabled: body.enabled };
    delete next.lastError;
    if (body.enabled) {
      next.enabledAt = new Date().toISOString();
    } else {
      next.disabledAt = new Date().toISOString();
    }

    await updateSettings({ [SETTINGS_KEY]: next });

    if (!body.enabled) {
      const stopped = await stopEngine();
      if (!stopped.ok) {
        return NextResponse.json(
          { error: stopped.error || "Failed to stop", ...getEngineStatus(await getSettings()) },
          { status: 500 },
        );
      }
      return NextResponse.json(
        { ...getEngineStatus(await getSettings()), applied: stopped },
        { headers: NO_STORE },
      );
    }

    // --- enable: verify the interpreter, then the binaries -----------------
    const python = await checkPython();
    if (!python.ok) {
      const hint = process.platform === "win32"
        ? "Install Python 3 and run: py -m pip install -r autoswitchip/requirements.txt"
        : "Install Python 3 and run: python3 -m pip install -r autoswitchip/requirements.txt (or set ASIP_PYTHON)";
      const detail = python.attempts
        .map((a) => `${a.candidate}: ${a.error || "unusable"}`)
        .slice(-3)
        .join("; ");
      return failEnable(next, `Python with requests+PyYAML is required. ${hint} — ${detail}`);
    }

    const binaries = await provisionBinaries();
    if (!binaries.ok) {
      return failEnable(next, binaries.error);
    }

    const applied = startEngine();
    if (!applied.ok) {
      return failEnable(next, applied.error);
    }

    return NextResponse.json(
      { ...getEngineStatus(await getSettings()), applied, binaries: binaries.present },
      { headers: NO_STORE },
    );
  } catch (error) {
    console.log("Error updating auto-switch-ip state:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * Leave the toggle off and record why.
 *
 * Reporting "on" for an engine that never started would send the user looking
 * for logs that will never appear; `lastError` is what the card renders.
 */
async function failEnable(next, message) {
  const error = String(message || "Failed to apply");
  await updateSettings({
    [SETTINGS_KEY]: { ...next, enabled: false, lastError: error },
  });
  return NextResponse.json(
    { error, ...getEngineStatus(await getSettings()) },
    { status: 500 },
  );
}
