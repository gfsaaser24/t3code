import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { assert, describe, it } from "vite-plus/test";

import { ForwardCompatibleArray, TrimmedNonEmptyString, TrimmedString } from "../baseSchemas.ts";

// Turbo (perf C4): the trimmed-string schema swapped `transformOrFail` for the pure
// `transform`, and `ForwardCompatibleArray` stopped decoding every element twice.
// These cases pin the wire behavior that must stay byte-identical across that swap.

const decodeTrimmed = Schema.decodeUnknownSync(TrimmedString);
const encodeTrimmed = Schema.encodeSync(TrimmedString);

describe("TrimmedString", () => {
  it("round-trips an already-trimmed value unchanged", () => {
    assert.equal(decodeTrimmed("already-trimmed"), "already-trimmed");
    assert.equal(encodeTrimmed("already-trimmed"), "already-trimmed");
    assert.equal(encodeTrimmed(decodeTrimmed("already-trimmed")), "already-trimmed");
  });

  it("trims an untrimmed value on decode", () => {
    assert.equal(decodeTrimmed("  padded  "), "padded");
    assert.equal(decodeTrimmed("\t\nmixed whitespace \r\n"), "mixed whitespace");
  });

  // This is the trap the plan named: the library's built-in trim helper trims on decode
  // only, so a value that never went through decode would newly ship untrimmed.
  it("trims on the encode-without-decode path too", () => {
    assert.equal(encodeTrimmed("  padded  "), "padded");
    assert.equal(encodeTrimmed("\t\nmixed whitespace \r\n"), "mixed whitespace");
  });

  it("trims struct fields on the encode side, without a decode first", () => {
    const Row = Schema.Struct({ label: TrimmedNonEmptyString });
    // The value never went through decode — it is handed straight to encode.
    assert.deepEqual(Schema.encodeUnknownSync(Row)({ label: "  built  " }), { label: "built" });
  });
});

describe("ForwardCompatibleArray", () => {
  it("drops elements this build cannot decode and keeps the rest", () => {
    const Ids = ForwardCompatibleArray(TrimmedNonEmptyString);

    // Two drops: the number and the whitespace-only string (empty after trimming).
    assert.deepEqual(Schema.decodeUnknownSync(Ids)(["  keep  ", 42, "also-keep", "   "]), [
      "keep",
      "also-keep",
    ]);
  });

  it("drops undecodable struct variants without failing the whole payload", () => {
    const Row = Schema.Struct({ id: TrimmedNonEmptyString, kind: Schema.Literal("known") });
    const Rows = ForwardCompatibleArray(Row);

    assert.deepEqual(
      Schema.decodeUnknownSync(Rows)([
        { id: " a ", kind: "known" },
        { id: "b", kind: "from-a-newer-server" },
        7,
      ]),
      [{ id: "a", kind: "known" }],
    );
  });

  it("encodes elements through the element schema", () => {
    const Ids = ForwardCompatibleArray(TrimmedNonEmptyString);
    assert.deepEqual(Schema.encodeUnknownSync(Ids)(["a", "  b  "]), ["a", "b"]);

    const Row = Schema.Struct({ id: TrimmedNonEmptyString, kind: Schema.Literal("known") });
    assert.deepEqual(
      Schema.encodeUnknownSync(ForwardCompatibleArray(Row))([{ id: "  a  ", kind: "known" }]),
      [{ id: "a", kind: "known" }],
    );
  });

  it("decodes each element exactly once", () => {
    let decodeCalls = 0;
    const Counted = Schema.String.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transform<string, string>({
          decode: (value) => {
            decodeCalls += 1;
            return value;
          },
          encode: (value) => value,
        }),
      ),
    );

    assert.deepEqual(Schema.decodeUnknownSync(ForwardCompatibleArray(Counted))(["a", "b", "c"]), [
      "a",
      "b",
      "c",
    ]);
    assert.equal(decodeCalls, 3);

    decodeCalls = 0;
    assert.deepEqual(Schema.decodeUnknownSync(ForwardCompatibleArray(Counted))(["a", 1]), ["a"]);
    assert.equal(decodeCalls, 1);
  });
});
