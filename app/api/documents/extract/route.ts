import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getClaudeClient, HAIKU } from "@/lib/claude";

// Fields we NEVER extract — leave blank
const FORBIDDEN_FIELDS = [
  "ssn", "social_security_number", "a_number", "alien_registration_number",
  "passport_number", "bank_account", "routing_number", "credit_card",
];

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { documentId, filePath, mimeType } = await req.json();
  if (!documentId || !filePath) {
    return NextResponse.json({ error: "Missing params" }, { status: 400 });
  }

  // Only process images and PDFs
  const isImage = mimeType?.startsWith("image/");
  if (!isImage) {
    return NextResponse.json({ skipped: true, reason: "Non-image file — skipping vision extraction" });
  }

  // Download file from Supabase storage
  const serviceClient = await createServiceClient();
  const { data: fileData, error: downloadError } = await serviceClient.storage
    .from("user-documents")
    .download(filePath);

  if (downloadError || !fileData) {
    return NextResponse.json({ error: "Could not download file" }, { status: 500 });
  }

  const buffer = await fileData.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");
  const mediaType = (mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp") ?? "image/jpeg";

  const claude = getClaudeClient();

  const response = await claude.messages.create({
    model: HAIKU,
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: base64 },
          },
          {
            type: "text",
            text: `Extract non-sensitive fields from this document.

DO NOT extract: SSN, Social Security Number, A-Number, Alien Registration Number, passport number, bank account numbers, routing numbers, or any financial credentials.

Safe fields to extract (only if visible and clearly readable):
- Full name
- Date of birth
- Country of birth
- Document type (e.g. "Refugee Travel Document", "EAD")
- Document expiration date
- Issue date
- Issuing country or agency

Return a JSON object with the field names as keys and extracted values as strings.
If a field is not visible, omit it.
Return ONLY valid JSON, no explanation. Example: {"full_name": "Jane Doe", "expiration_date": "2026-03-15"}`,
          },
        ],
      },
    ],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "{}";

  let extracted: Record<string, string> = {};
  try {
    const raw = text.trim().replace(/^```json\s*/i, "").replace(/```\s*$/, "");
    extracted = JSON.parse(raw);

    // Remove any forbidden fields that may have been extracted despite instructions
    FORBIDDEN_FIELDS.forEach((f) => delete extracted[f]);
  } catch {
    extracted = {};
  }

  await serviceClient
    .from("documents")
    .update({ extracted_fields: extracted })
    .eq("id", documentId);

  return NextResponse.json({ extracted });
}
