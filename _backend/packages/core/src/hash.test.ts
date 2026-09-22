import { describe, expect, it } from "vitest";
import { fromHex, hmacSha256, isHex32, randomBytes32, sha256, sha256Hex, toHex } from "./hash.js";

describe("hash and encoding primitives", () => {
  it("matches the SHA-256 known-answer vector for text and bytes", () => {
    const expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(sha256("abc").toString("hex")).toBe(expected);
    expect(sha256Hex(Buffer.from("abc"))).toBe(`0x${expected}`);
    expect(sha256Hex("")).toBe("0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("matches RFC 4231 HMAC-SHA-256 test case 1", () => {
    expect(hmacSha256(Buffer.alloc(20, 0x0b), "Hi There").toString("hex"))
      .toBe("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
  });

  it("round-trips bytes, upper-case digits, optional prefix and empty buffers", () => {
    const bytes = Buffer.from([0, 1, 15, 128, 255]);
    expect(toHex(bytes)).toBe("0x00010f80ff");
    expect(fromHex(toHex(bytes))).toEqual(bytes);
    expect(fromHex("00010F80FF")).toEqual(bytes);
    expect(fromHex("0x")).toEqual(Buffer.alloc(0));
    expect(fromHex("")).toEqual(Buffer.alloc(0));
  });

  it("generates independent full-length random keys", () => {
    const first = randomBytes32();
    const second = randomBytes32();
    expect(first).toHaveLength(32);
    expect(second).toHaveLength(32);
    expect(first).not.toEqual(second);
  });

  it.each([
    [`0x${"ab".repeat(32)}`, true],
    [`0x${"AB".repeat(32)}`, true],
    ["ab".repeat(32), false],
    [`0x${"ab".repeat(31)}`, false],
    [`0x${"ab".repeat(33)}`, false],
    [`0x${"gg".repeat(32)}`, false],
    ["", false],
  ])("validates exact bytes32 encoding %#", (value, valid) => {
    expect(isHex32(value as string)).toBe(valid);
  });
});
