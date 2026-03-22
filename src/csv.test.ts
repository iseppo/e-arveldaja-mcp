import { describe, it, expect } from "vitest";
import { parseCSV, parseCSVLine } from "./csv.js";

describe("parseCSVLine", () => {
  it("parses simple comma-separated values", () => {
    expect(parseCSVLine("a,b,c")).toEqual(["a", "b", "c"]);
    expect(parseCSVLine("foo,bar,baz")).toEqual(["foo", "bar", "baz"]);
  });

  it("parses quoted fields containing commas", () => {
    expect(parseCSVLine('"hello, world",b,c')).toEqual(["hello, world", "b", "c"]);
    expect(parseCSVLine('a,"x,y,z",c')).toEqual(["a", "x,y,z", "c"]);
  });

  it('unescapes doubled double-quotes inside quoted fields ("" → ")', () => {
    expect(parseCSVLine('"say ""hi""",b')).toEqual(['say "hi"', "b"]);
    expect(parseCSVLine('"a""b""c"')).toEqual(['a"b"c']);
  });

  it("uses a custom delimiter", () => {
    expect(parseCSVLine("a;b;c", ";")).toEqual(["a", "b", "c"]);
    expect(parseCSVLine('"a;b";c;d', ";")).toEqual(["a;b", "c", "d"]);
  });

  it("handles empty fields", () => {
    expect(parseCSVLine("a,,c")).toEqual(["a", "", "c"]);
    expect(parseCSVLine(",b,")).toEqual(["", "b", ""]);
    expect(parseCSVLine(",,")).toEqual(["", "", ""]);
  });

  it("handles a single field", () => {
    expect(parseCSVLine("hello")).toEqual(["hello"]);
    expect(parseCSVLine('"hello"')).toEqual(["hello"]);
  });

  it("returns a single empty string for empty input", () => {
    expect(parseCSVLine("")).toEqual([""]);
  });
});

describe("parseCSV", () => {
  it("parses CRLF-delimited rows without leaving carriage returns in fields", () => {
    expect(parseCSV("ID,Note\r\n1,Jar top-up\r\n2,Other\r\n")).toEqual([
      ["ID", "Note"],
      ["1", "Jar top-up"],
      ["2", "Other"],
    ]);
  });

  it("preserves embedded newlines inside quoted fields while splitting records", () => {
    expect(parseCSV('ID,Note\r\n1,"line 1\r\nline 2"\r\n')).toEqual([
      ["ID", "Note"],
      ["1", "line 1\r\nline 2"],
    ]);
  });
});
