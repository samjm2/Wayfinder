import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { randomBytes } from "crypto";

// Postgres error code for "relation does not exist" (table missing).
const UNDEFINED_TABLE = "42P01";

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Auto-fill can't work without a signing secret for the extension token
  // exchange. Surface a clean, non-throwing 503 so the UI can show a friendly
  // "not available yet" message rather than minting a code that can't be used.
  if (!process.env.EXTENSION_JWT_SECRET) {
    return NextResponse.json({ error: "Auto-fill is not available yet.", unavailable: true }, { status: 503 });
  }

  // Mint a random 8-character pairing code.
  const code = randomBytes(4).toString("hex").toUpperCase();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

  const serviceClient = await createServiceClient();
  const { error } = await serviceClient
    .from("extension_pairings")
    .insert({ code, user_id: user.id, expires_at: expiresAt.toISOString() });

  if (error) {
    // If the table hasn't been migrated yet, this isn't a real server fault —
    // report it as "not available yet" (503) so the client shows the friendly
    // message instead of a raw "Could not find the table" error.
    const code = (error as { code?: string }).code;
    const missingTable =
      code === UNDEFINED_TABLE || /does not exist|could not find the table/i.test(error.message);
    if (missingTable) {
      return NextResponse.json({ error: "Auto-fill is not available yet.", unavailable: true }, { status: 503 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ code, expiresAt: expiresAt.toISOString() });
}
