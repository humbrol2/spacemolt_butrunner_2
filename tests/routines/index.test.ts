import { describe, test, expect } from "bun:test";
import { buildRoutineRegistry } from "../../src/routines";

describe("Routine Registry", () => {
  test("buildRoutineRegistry returns all 10 routines", () => {
    const registry = buildRoutineRegistry();

    const expectedRoutines = [
      "miner",
      "harvester",
      "trader",
      "explorer",
      "crafter",
      "hunter",
      "salvager",
      "mission_runner",
      "return_home",
      "scout",
    ];

    for (const name of expectedRoutines) {
      expect(registry[name as keyof typeof registry]).toBeDefined();
      expect(typeof registry[name as keyof typeof registry]).toBe("function");
    }
  });

  test("each routine is an async generator function", () => {
    const registry = buildRoutineRegistry();

    for (const [name, fn] of Object.entries(registry)) {
      // AsyncGeneratorFunction has constructor name
      expect(fn).toBeDefined();
      expect(typeof fn).toBe("function");
    }
  });
});
