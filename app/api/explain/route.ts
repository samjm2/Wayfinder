import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { getClaudeClient, HAIKU } from "@/lib/claude";

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Parse the body defensively — a malformed JSON body must not 500 with HTML.
  let text: unknown;
  let language: unknown;
  try {
    const body = await req.json();
    text = body.text;
    language = body.language;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (typeof text !== "string" || !text.trim()) {
    return NextResponse.json({ error: "Missing text" }, { status: 400 });
  }
  const lang = typeof language === "string" && language ? language : "en";

  const claude = getClaudeClient();

  try {
    const response = await claude.messages.create({
      model: HAIKU,
      max_tokens: 2048,
      system: `You help immigrants and refugees understand confusing government letters and forms.
Write your response in language code: ${lang}. If language is "en", respond in English.
Use very simple, plain language. Assume the user may have low literacy or be new to the U.S.`,
      messages: [
        {
          role: "user",
          content: `Please explain this letter or form in plain language. Structure your response as:

1. **What is this?** (1-2 sentences)
2. **What is most important?** (bullet points of key facts)
3. **What do I need to do?** (checklist of action items)
4. **What is my single next step?** (one clear action)
5. **Is there a deadline?** (yes/no and date if visible)

Document text:
${text.slice(0, 4000)}`,
        },
      ],
    });

    // Extract text robustly across ALL blocks, not just content[0].
    const explanation = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (!explanation) {
      return NextResponse.json(
        { error: "The assistant returned an empty response. Please try again." },
        { status: 502 },
      );
    }

    return NextResponse.json({ explanation });
  } catch (error) {
    // Map typed SDK errors to user-facing messages. Never leak raw error text.
    if (error instanceof Anthropic.RateLimitError) {
      const retryAfter = error.headers?.get("retry-after") ?? undefined;
      return NextResponse.json(
        {
          error: "The assistant is busy right now. Please wait a moment and try again.",
          ...(retryAfter ? { retryAfter } : {}),
        },
        { status: 429 },
      );
    }
    if (
      error instanceof Anthropic.AuthenticationError ||
      error instanceof Anthropic.PermissionDeniedError
    ) {
      console.error("[explain] auth/permission error:", error);
      return NextResponse.json(
        { error: "The assistant is temporarily unavailable. Please try again later." },
        { status: 503 },
      );
    }
    if (error instanceof Anthropic.InternalServerError) {
      return NextResponse.json(
        { error: "The assistant is temporarily unavailable. Please try again in a few minutes." },
        { status: 503 },
      );
    }
    if (error instanceof Anthropic.BadRequestError) {
      console.error("[explain] bad request to Claude:", error);
      return NextResponse.json(
        { error: "Something went wrong processing your request." },
        { status: 500 },
      );
    }
    if (error instanceof Anthropic.APIError) {
      if (error.status === 429) {
        const retryAfter = error.headers?.get("retry-after") ?? undefined;
        return NextResponse.json(
          {
            error: "The assistant is busy right now. Please wait a moment and try again.",
            ...(retryAfter ? { retryAfter } : {}),
          },
          { status: 429 },
        );
      }
      console.error("[explain] Claude API error:", error);
      return NextResponse.json(
        { error: "The assistant is temporarily unavailable. Please try again in a few minutes." },
        { status: 503 },
      );
    }
    console.error("[explain] unexpected error:", error);
    return NextResponse.json(
      { error: "We could not reach the assistant. Check your connection and try again." },
      { status: 503 },
    );
  }
}
