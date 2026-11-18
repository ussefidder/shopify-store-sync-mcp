import { describe, expect, it } from "vitest";
import { searchValue } from "../src/refs.js";

describe("searchValue", () => {
  it("quotes a plain value", () => {
    expect(searchValue("logo.png")).toBe("'logo.png'");
  });
  it("escapes quotes", () => {
    expect(searchValue("it's.png")).toBe("'it\\'s.png'");
  });
  it("escapes backslashes before quotes, so a trailing backslash can't end the value", () => {
    expect(searchValue("a\\")).toBe("'a\\\\'");
    expect(searchValue("a\\'b")).toBe("'a\\\\\\'b'");
  });
});
