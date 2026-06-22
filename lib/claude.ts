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

// Single model for the whole app. Eligibility decisions are computed
// deterministically in lib/eligibility/engine.ts, so Claude is only ever asked
// for plain-language narrative / extraction / planning text. We use Sonnet 4.6
// for stronger reasoning on form planning and document extraction.
export const SONNET = "claude-sonnet-4-6" as const;
