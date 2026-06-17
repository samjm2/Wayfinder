import Anthropic from "@anthropic-ai/sdk";

// This module is SERVER-ONLY. Never import from client components.
// The API key must never be exposed to the browser.

let client: Anthropic | null = null;

export function getClaudeClient(): Anthropic {
  if (!client) {
    client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }
  return client;
}

// Single model for the whole app. Haiku 4.5 is the cheapest Claude model
// ($1/$5 per 1M input/output tokens) and is sufficient here: eligibility
// decisions are computed deterministically in lib/eligibility/engine.ts, so
// Claude is only ever asked for plain-language narrative / extraction text.
export const HAIKU = "claude-haiku-4-5" as const;
