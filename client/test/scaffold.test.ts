import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";

describe("@agentkv/client scaffold", () => {
  it("exports VERSION", () => {
    expect(VERSION).toBe("0.2.1");
  });
});
