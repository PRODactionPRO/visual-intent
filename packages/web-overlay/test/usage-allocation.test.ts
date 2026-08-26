import { describe, expect, it } from "vitest";

import { allocateEstimatedTaskUsage } from "../src/index.js";

describe("allocateEstimatedTaskUsage", () => {
  it("conserves every exact batch total while producing unequal task estimates", () => {
    const allocations = allocateEstimatedTaskUsage(
      {
        input: 30_109_710,
        cached: 29_208_832,
        cacheWrite: 0,
        output: 110_052,
        reasoning: 54_923,
        costMicros: 17_488_085,
      },
      [
        {
          id: "one",
          categories: ["layout", "style"],
          scale: "region",
          changedFiles: ["one.tsx"],
        },
        {
          id: "two",
          categories: ["style"],
          scale: "element",
          changedFiles: ["two.tsx", "three.tsx", "four.tsx"],
        },
        {
          id: "three",
          categories: ["layout", "behavior"],
          scale: "region",
          changedFiles: ["five.tsx"],
        },
      ],
    );
    const values = Object.values(allocations);
    const sum = (key: keyof (typeof values)[number]): number =>
      values.reduce((total, value) => total + Number(value[key] ?? 0), 0);

    expect(sum("input")).toBe(30_109_710);
    expect(sum("cached")).toBe(29_208_832);
    expect(sum("cacheWrite")).toBe(0);
    expect(sum("output")).toBe(110_052);
    expect(sum("reasoning")).toBe(54_923);
    expect(sum("costMicros")).toBe(17_488_085);
    expect(sum("total")).toBe(30_219_762);
    expect(sum("share")).toBeCloseTo(1, 12);
    expect(allocations.three!.share).toBeGreaterThan(allocations.one!.share);
    expect(allocations.one!.share).toBeGreaterThan(allocations.two!.share);
  });

  it("uses an equal deterministic fallback when task signals are absent", () => {
    const allocations = allocateEstimatedTaskUsage(
      {
        input: 10,
        cached: 4,
        cacheWrite: 0,
        output: 2,
        reasoning: 1,
        costMicros: 5,
      },
      [{ id: "first" }, { id: "second" }],
    );

    expect(allocations.first).toMatchObject({
      input: 5,
      cached: 2,
      output: 2,
      costMicros: 3,
      share: 0.5,
    });
    expect(allocations.second).toMatchObject({
      input: 5,
      cached: 2,
      output: 0,
      costMicros: 2,
      share: 0.5,
    });
  });

  it("attributes a single-task execution at one hundred percent", () => {
    expect(
      allocateEstimatedTaskUsage(
        {
          input: 100,
          cached: 80,
          cacheWrite: 0,
          output: 20,
          reasoning: 10,
          costMicros: 25,
        },
        [
          {
            id: "only",
            categories: ["bug"],
            scale: "system",
            changedFiles: ["a.ts", "b.ts"],
          },
        ],
      ).only,
    ).toMatchObject({
      input: 100,
      cached: 80,
      output: 20,
      reasoning: 10,
      costMicros: 25,
      total: 120,
      share: 1,
    });
  });

  it("keeps cached input and reasoning within their parent token totals", () => {
    const allocations = allocateEstimatedTaskUsage(
      {
        input: 17,
        cached: 16,
        cacheWrite: 0,
        output: 11,
        reasoning: 10,
      },
      [
        { id: "tiny", categories: ["style"], scale: "element" },
        {
          id: "large",
          categories: ["bug"],
          scale: "system",
          changedFiles: ["a", "b", "c", "d"],
        },
      ],
    );

    for (const allocation of Object.values(allocations)) {
      expect(allocation.cached + allocation.cacheWrite).toBeLessThanOrEqual(
        allocation.input,
      );
      expect(allocation.reasoning).toBeLessThanOrEqual(allocation.output);
    }
  });

  it("imputes missing signals neutrally instead of treating them as extra work", () => {
    const allocations = allocateEstimatedTaskUsage(
      {
        input: 100,
        cached: 80,
        cacheWrite: 0,
        output: 20,
        reasoning: 10,
      },
      [
        { id: "missing" },
        {
          id: "known",
          categories: ["style"],
          scale: "element",
          changedFiles: ["a.ts"],
        },
      ],
    );

    expect(allocations.missing!.share).toBe(allocations.known!.share);
  });
});
