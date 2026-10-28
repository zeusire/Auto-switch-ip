import { NextResponse } from "next/server";
import { clearLog, readLogTail } from "@/lib/autoswitchip/engine";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/autoswitchip/logs?lines=200 — tail of the engine's daemon.log
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const parsed = Number.parseInt(searchParams.get("lines") || "200", 10);
    const lines = Number.isFinite(parsed)
      ? Math.min(Math.max(parsed, 20), 2000)
      : 200;
    return NextResponse.json(readLogTail({ lines }), { headers: NO_STORE });
  } catch (error) {
    console.log("Error reading auto-switch-ip log:", error);
    return NextResponse.json({ error: "Failed to read log" }, { status: 500 });
  }
}

// DELETE /api/autoswitchip/logs — truncate the log file
export async function DELETE() {
  const result = clearLog();
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  return NextResponse.json(result, { headers: NO_STORE });
}
