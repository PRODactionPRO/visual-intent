import type {
  ApiEquivalentCost,
  OpenAiApiPricingSnapshot,
  TokenUsage,
} from "@visual-intent/protocol";

export const ISOLATED_WORKER_MODEL = "gpt-5.6-sol";
export const ISOLATED_WORKER_REASONING_POLICY = "ultra";
export const CODEX_SDK_ADAPTER_VERSION = "0.147.0";

export const GPT_5_6_SOL_PRICING_SNAPSHOT = {
  id: "openai-gpt-5.6-sol-standard-promo-2026-08-25",
  capturedAt: "2026-08-25T00:00:00.000Z",
  sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
  currency: "USD",
  serviceTier: "standard",
  contextTierAssumption: "up-to-272k-input-per-request",
  inputUsdPerMillion: "4.00",
  cachedInputUsdPerMillion: "0.40",
  cacheWriteInputUsdPerMillion: "5.00",
  outputUsdPerMillion: "20.00",
  promotionalThrough: "2026-11-21",
} as const satisfies OpenAiApiPricingSnapshot;

const NANO_USD_PER_TOKEN = {
  input: 4_000n,
  cachedInput: 400n,
  cacheWriteInput: 5_000n,
  output: 20_000n,
} as const;

function formatNanoUsd(value: bigint): string {
  const units = value / 1_000_000_000n;
  const fraction = String(value % 1_000_000_000n).padStart(9, "0");
  return `${units}.${fraction}`;
}

export function calculateOpenAiApiEquivalentCost(
  tokens: TokenUsage,
  calculatedAt = new Date(),
): ApiEquivalentCost {
  const promotionalThrough = GPT_5_6_SOL_PRICING_SNAPSHOT.promotionalThrough;
  const promotionEndsAt = new Date(
    `${promotionalThrough}T23:59:59.999Z`,
  ).getTime();
  if (calculatedAt.getTime() > promotionEndsAt) {
    return {
      availability: "unavailable",
      reason: `OpenAI pricing snapshot expired after ${promotionalThrough}; refresh the official tariff before calculating new costs`,
    };
  }
  const attributedInput =
    tokens.cachedInputTokens + tokens.cacheWriteInputTokens;
  if (
    attributedInput > tokens.inputTokens ||
    tokens.reasoningOutputTokens > tokens.outputTokens
  ) {
    return {
      availability: "unavailable",
      reason:
        "Token subsets reported by the Codex SDK are inconsistent with aggregate usage",
    };
  }

  const uncachedInputTokens = tokens.inputTokens - attributedInput;
  const amountNanoUsd =
    BigInt(uncachedInputTokens) * NANO_USD_PER_TOKEN.input +
    BigInt(tokens.cachedInputTokens) * NANO_USD_PER_TOKEN.cachedInput +
    BigInt(tokens.cacheWriteInputTokens) * NANO_USD_PER_TOKEN.cacheWriteInput +
    BigInt(tokens.outputTokens) * NANO_USD_PER_TOKEN.output;

  return {
    availability: "calculated",
    kind: "openai-api-equivalent",
    scope: "apply-batch-turn",
    model: ISOLATED_WORKER_MODEL,
    reasoningPolicy: ISOLATED_WORKER_REASONING_POLICY,
    amountUsd: formatNanoUsd(amountNanoUsd),
    billableTokens: {
      uncachedInputTokens,
      cachedInputTokens: tokens.cachedInputTokens,
      cacheWriteInputTokens: tokens.cacheWriteInputTokens,
      outputTokens: tokens.outputTokens,
    },
    pricingSnapshot: GPT_5_6_SOL_PRICING_SNAPSHOT,
    reasoningIncludedInOutput: true,
    estimateBasis: "aggregate-turn-short-context",
  };
}
