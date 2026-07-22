import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildResponseFixtures,
  measureResponseFixtures,
  REQUIRED_RESPONSE_FIXTURE_NAMES,
} from "../scripts/measure-response-fixtures.js";
import { parseMcpResponse } from "./mcp-json.js";

describe("response context-budget baseline", () => {
  it("pins deterministic final encoded bytes without enforcing a target budget", async () => {
    const expected = JSON.parse(await readFile(
      new URL("../testdata/context-budgets.json", import.meta.url),
      "utf8",
    ));

    const first = await measureResponseFixtures();
    const second = await measureResponseFixtures();

    expect(first).toEqual(second);
    expect(first).toEqual(expected);
  });

  it("covers every required representative response and round-trips losslessly", async () => {
    const fixtures = await buildResponseFixtures();
    expect(fixtures.map((fixture) => fixture.name)).toEqual(REQUIRED_RESPONSE_FIXTURE_NAMES);
    for (const fixture of fixtures) {
      expect(parseMcpResponse(fixture.encoded)).toEqual(fixture.payload);
    }
  });
});
