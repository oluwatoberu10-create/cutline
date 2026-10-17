import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { AppError } from "@/lib/errors";

/**
 * Language-model providers behind one interface. Each adapter calls its
 * vendor's documented API for schema-constrained JSON, and every result is
 * validated again with zod before anything is stored — model output is
 * untrusted input.
 */

export type LlmRequest<T> = {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  schemaName: string;
  maxTokens: number;
  effort: "low" | "medium" | "high";
};

export interface LlmProvider {
  readonly provider: "anthropic" | "openai" | "mock";
  readonly model: string;
  readonly isMock: boolean;
  generateJson<T>(req: LlmRequest<T>): Promise<T>;
}

export class ProviderError extends AppError {
  constructor(message: string, readonly retryable: boolean) {
    super("PROVIDER_UNAVAILABLE", message);
  }
}

/* ── Anthropic (official SDK) ─────────────────────────────────────────── */

export class AnthropicLlm implements LlmProvider {
  readonly provider = "anthropic" as const;
  readonly isMock = false;
  private client: Anthropic;

  constructor(apiKey: string, readonly model: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 10 * 60 * 1000 });
  }

  async generateJson<T>(req: LlmRequest<T>): Promise<T> {
    try {
      const response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: "user", content: req.prompt }],
        thinking: { type: "adaptive" },
        output_config: { effort: req.effort, format: zodOutputFormat(req.schema as z.ZodType) },
        // If the model declines on policy grounds, retry server-side on its default fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      if (response.stop_reason === "refusal") {
        throw new ProviderError(`The model declined this request${response.stop_details?.category ? ` (${response.stop_details.category})` : ""}.`, false);
      }
      if (response.stop_reason === "max_tokens") throw new ProviderError("The model ran out of output tokens; raise maxOutputTokens in the agent configuration.", false);
      if (response.parsed_output == null) throw new ProviderError("The model returned output that did not match the expected format.", true);
      return req.schema.parse(response.parsed_output);
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (err instanceof Anthropic.AuthenticationError) throw new ProviderError("Anthropic rejected the API key. Update it in Integrations.", false);
      if (err instanceof Anthropic.PermissionDeniedError) throw new ProviderError("The Anthropic key does not have access to this model.", false);
      if (err instanceof Anthropic.NotFoundError) throw new ProviderError(`Anthropic model "${this.model}" was not found. Check the model in the agent configuration.`, false);
      if (err instanceof Anthropic.BadRequestError && /credit balance/i.test(err.message)) throw new ProviderError("The Anthropic account has no remaining credits. Add credits at console.anthropic.com → Plans & Billing, then retry.", false);
      if (err instanceof Anthropic.BadRequestError) throw new ProviderError(`Anthropic rejected the request: ${err.message}`, false);
      if (err instanceof Anthropic.RateLimitError) throw new ProviderError("Anthropic rate limit reached; the job will retry.", true);
      if (err instanceof Anthropic.APIError) throw new ProviderError(`Anthropic API error ${err.status ?? ""}: ${err.message}`, true);
      if (err instanceof z.ZodError) throw new ProviderError("The model output failed validation.", true);
      throw err;
    }
  }
}

/* ── OpenAI (Chat Completions with json_schema response format) ───────── */

export class OpenAiLlm implements LlmProvider {
  readonly provider = "openai" as const;
  readonly isMock = false;

  constructor(private apiKey: string, readonly model: string, private fetchImpl: typeof fetch = fetch) {}

  async generateJson<T>(req: LlmRequest<T>): Promise<T> {
    const res = await this.fetchImpl("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        max_completion_tokens: req.maxTokens,
        messages: [{ role: "system", content: req.system }, { role: "user", content: req.prompt }],
        response_format: { type: "json_schema", json_schema: { name: req.schemaName, schema: z.toJSONSchema(req.schema as z.ZodType, { unrepresentable: "any" }), strict: false } },
      }),
    });
    if (res.status === 401) throw new ProviderError("OpenAI rejected the API key. Update it in Integrations.", false);
    if (res.status === 404) throw new ProviderError(`OpenAI model "${this.model}" was not found.`, false);
    if (res.status === 429) throw await openAi429(res);
    if (!res.ok) throw new ProviderError(`OpenAI API error ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status >= 500);
    const body = await res.json() as { choices?: { message?: { content?: string; refusal?: string } ; finish_reason?: string }[] };
    const choice = body.choices?.[0];
    if (choice?.message?.refusal) throw new ProviderError("The model declined this request.", false);
    if (choice?.finish_reason === "length") throw new ProviderError("The model ran out of output tokens.", false);
    try {
      return req.schema.parse(JSON.parse(choice?.message?.content ?? ""));
    } catch {
      throw new ProviderError("The model returned output that did not match the expected format.", true);
    }
  }
}

/* ── mock (automated tests only) ──────────────────────────────────────── */

/**
 * Deterministic stand-in used ONLY when CUTLINE_ENABLE_MOCK_PROVIDERS=true
 * outside production. Its outputs are stored with isMock=true and labelled in
 * the UI, so they can never be mistaken for real model output.
 */
export class MockLlm implements LlmProvider {
  readonly provider = "mock" as const;
  readonly model = "mock-llm";
  readonly isMock = true;
  constructor(private responder: (req: LlmRequest<unknown>) => unknown) {}
  async generateJson<T>(req: LlmRequest<T>): Promise<T> {
    return req.schema.parse(this.responder(req as LlmRequest<unknown>));
  }
}

/** OpenAI uses 429 for both rate limits and an exhausted balance; only the former is worth retrying. */
async function openAi429(res: Response): Promise<ProviderError> {
  const j = await res.json().catch(() => ({})) as { error?: { type?: string; code?: string } };
  if (j.error?.type === "insufficient_quota" || j.error?.code === "insufficient_quota" || j.error?.code === "credit_balance_exhausted") {
    return new ProviderError("The OpenAI account has no remaining credits. Add credits at platform.openai.com → Billing, then retry.", false);
  }
  return new ProviderError("OpenAI rate limit reached; the job will retry.", true);
}
