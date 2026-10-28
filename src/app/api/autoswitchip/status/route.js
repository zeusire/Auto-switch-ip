import { NextResponse } from "next/server";
import { getSettings } from "@/lib/db/index.js";
import { getEngineStatus, queryEngineStatus } from "@/lib/autoswitchip/engine";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/autoswitchip/status — toggle state, process state, tunnel/ledger detail
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const settings = await getSettings();
    const base = getEngineStatus(settings);

    // `?deep=1` asks the engine itself for tunnel/ledger detail. The dashboard
    // polls the shallow form while a toggle is in flight (it only needs
    // running/pid), and the deep form on the page's refresh timer. A dead
    // engine cannot answer, so the shallow form is returned instead of a
    // guaranteed 12 s timeout on every poll.
    if (searchParams.get("deep") !== "1" || !base.running) {
      return NextResponse.json(base, { headers: NO_STORE });
    }
    const engine = await queryEngineStatus();
    return NextResponse.json({ ...base, engine }, { headers: NO_STORE });
  } catch (error) {
    console.log("Error reading auto-switch-ip status:", error);
    return NextResponse.json(
      { error: "Failed to read status" },
      { status: 500, headers: NO_STORE },
    );
  }
}
