import { expect } from "buckwheat";
import { describe, it } from "mocha";
import {
  CompatibilityMatrix,
  CompatibilityMatrixResult,
  buildCompatibilityMatrix,
} from "./compatibility_matrix.js";
import { ModuleSet } from "./module_set.js";

describe("compatibility matrix", () => {
  it("baseline: identical schemas yield an empty matrix, compatible on all dimensions", () => {
    const source = `
      struct Point(101) {
        x: int32;
        y: int32;
      }
      enum Status(102) {
        ok;
        error: string;
      }
      method GetPoint(string): Point = 201;
    `;
    const matrix = buildOk(singleModule(source), singleModule(source));
    expect(matrix.entries).toMatch([]);
    expect(matrix.verdict).toMatch({
      wire: true,
      sourceApi: true,
      semanticDefault: true,
    });
  });

  it("added optional field: compatible everywhere, notes the semantic-default effect with field identity", () => {
    const matrix = buildOk(
      singleModule(`struct Point(101) { x: int32; }`),
      singleModule(`struct Point(101) { x: int32; nick: string?; }`),
    );
    expect(matrix.verdict).toMatch({
      wire: true,
      sourceApi: true,
      semanticDefault: true,
    });
    expect(matrix.entries).toMatch([
      {
        changeKind: "field-added",
        declaration: { kind: "record", name: "Point", number: 101 },
        field: { name: "nick", number: 1 },
        effects: [{ dimension: "semantic-default", breaking: false }],
      },
    ]);
    expect(matrix.entries[0]!.message).toMatch(/Point\(101\)/);
    expect(matrix.entries[0]!.message).toMatch(/nick\(1\)/);
  });

  it("field number reuse after 'removed' is wire-breaking and identifies the reintroduced field", () => {
    const matrix = buildOk(
      singleModule(`
        struct A(101) {
          foo: string;
          removed;
        }
      `),
      singleModule(`
        struct A(101) {
          foo: string;
          bar: int32;
        }
      `),
    );
    expect(matrix.verdict.wire).toBe(false);
    expect(matrix.entries).toMatch([
      {
        changeKind: "removed-number-reintroduced",
        declaration: { kind: "record", name: "A", number: 101 },
        field: { name: "bar", number: 1 },
        effects: [
          { dimension: "wire", breaking: true },
          { dimension: "source-api", breaking: true },
        ],
      },
    ]);
  });

  it("type narrowing (int64 -> int32) is wire-breaking and points at the exact field", () => {
    const matrix = buildOk(
      singleModule(`struct S(101) { v: int64; }`),
      singleModule(`struct S(101) { v: int32; }`),
    );
    expect(matrix.verdict).toMatch({ wire: false, sourceApi: false });
    expect(matrix.entries).toMatch([
      {
        changeKind: "illegal-type-change",
        declaration: { kind: "record", name: "S", number: 101 },
        field: { name: "v", number: 0 },
      },
    ]);
    expect(matrix.entries[0]!.message).toMatch(/illegal type change/);
  });

  it("enum variant addition is source-api visible but wire-compatible; removal is wire-breaking", () => {
    const before = singleModule(`
      enum E(102) {
        a;
        b: string;
      }
    `);
    const variantAdded = buildOk(
      before,
      singleModule(`
        enum E(102) {
          a;
          b: string;
          c: int32;
        }
      `),
    );
    expect(variantAdded.verdict).toMatch({
      wire: true,
      sourceApi: true,
      semanticDefault: true,
    });
    expect(variantAdded.entries).toMatch([
      {
        changeKind: "variant-added",
        declaration: { kind: "record", name: "E", number: 102 },
        field: { name: "c", number: 3 },
        effects: [{ dimension: "source-api", breaking: false }],
      },
    ]);
    const variantRemoved = buildOk(
      before,
      singleModule(`
        enum E(102) {
          a;
        }
      `),
    );
    expect(variantRemoved.verdict.wire).toBe(false);
    expect(variantRemoved.entries).toMatch([
      {
        changeKind: "missing-variant",
        declaration: { kind: "record", name: "E", number: 102 },
        field: { name: "b", number: 2 },
      },
    ]);
  });

  it("cross-file move keeps wire compatibility but flags the source-api dimension", () => {
    const matrix = buildOk(
      compileOk(
        new Map([
          ["a.skir", `struct Foo(101) { x: int32; }`],
          ["b.skir", `struct Bar(102) { y: int32; }`],
        ]),
      ),
      compileOk(
        new Map([
          ["a.skir", ``],
          ["b.skir", `struct Bar(102) { y: int32; } struct Foo(101) { x: int32; }`],
        ]),
      ),
    );
    expect(matrix.verdict).toMatch({ wire: true, sourceApi: false });
    expect(matrix.entries).toMatch([
      {
        changeKind: "record-moved",
        declaration: {
          kind: "record",
          name: "Foo",
          number: 101,
          modulePath: "b.skir",
        },
        field: null,
        effects: [{ dimension: "source-api", breaking: true }],
      },
    ]);
    expect(matrix.entries[0]!.message).toMatch(
      /moved from module 'a\.skir' to 'b\.skir'/,
    );
  });

  it("reference cycles terminate and produce a stable matrix", () => {
    const before = () =>
      singleModule(`
        struct A(101) {
          b: B;
        }
        struct B(102) {
          a: A;
          bs: [B];
        }
      `);
    const after = () =>
      singleModule(`
        struct A(101) {
          b: B;
          extra: string;
        }
        struct B(102) {
          a: A;
          bs: [B];
        }
      `);
    const first = buildOk(before(), after());
    const second = buildOk(before(), after());
    expect(first.entries).toMatch([
      {
        changeKind: "field-added",
        declaration: { name: "A", number: 101 },
        field: { name: "extra", number: 1 },
      },
    ]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("input order permutation yields an identical matrix", () => {
    const modules: ReadonlyArray<readonly [string, string, string]> = [
      [
        "a.skir",
        `import * as b from "./b.skir";
         struct Point(101) { x: int32; p: b.Pair; }`,
        `import * as b from "./b.skir";
         struct Point(101) { x: int32; p: b.Pair; nick: string?; }`,
      ],
      [
        "b.skir",
        `import * as c from "./c.skir";
         struct Pair(102) { left: c.Token; right: c.Token; }`,
        `import * as c from "./c.skir";
         struct Pair(102) { left: c.Renamed; right: c.Renamed; }`,
      ],
      [
        "c.skir",
        `struct Token(103) { value: string; }
         method Echo(string): string = 201;`,
        `struct Renamed(103) { value: string; }
         method Echo(string): string = 201;
         method Shout(string): string = 202;`,
      ],
    ];
    const makeMap = (
      side: 1 | 2,
      order: readonly number[],
    ): Map<string, string> => {
      const map = new Map<string, string>();
      for (const i of order) {
        const [path, beforeSource, afterSource] = modules[i]!;
        map.set(path, side === 1 ? beforeSource : afterSource);
      }
      return map;
    };
    const matrix1 = buildOk(
      compileOk(makeMap(1, [0, 1, 2])),
      compileOk(makeMap(2, [0, 1, 2])),
    );
    const matrix2 = buildOk(
      compileOk(makeMap(1, [2, 0, 1])),
      compileOk(makeMap(2, [1, 2, 0])),
    );
    expect(matrix1.entries.length > 0).toBe(true);
    expect(JSON.stringify(matrix2)).toBe(JSON.stringify(matrix1));
    // The matrix mentions the rename, the added field and the added method,
    // each with its declaration identity.
    expect(matrix1.entries).toMatch([
      {
        changeKind: "field-added",
        declaration: { name: "Point", number: 101, modulePath: "a.skir" },
        field: { name: "nick", number: 2 },
      },
      {
        changeKind: "record-renamed",
        declaration: { name: "Renamed", number: 103, modulePath: "c.skir" },
      },
      {
        changeKind: "method-added",
        declaration: { name: "Shout", number: 202, modulePath: "c.skir" },
      },
    ]);
  });

  it("matches fields by stable number, not by name (rename is not an add+remove)", () => {
    // Renaming a field while keeping its number: wire-compatible, no
    // "field-added"/"missing" entries. A name-based comparison would
    // (wrongly) report a removed field and an added field.
    const renamed = buildOk(
      singleModule(`struct S(101) { foo: string; }`),
      singleModule(`struct S(101) { bar: string; }`),
    );
    expect(renamed.verdict.wire).toBe(true);
    expect(renamed.entries).toMatch([
      {
        changeKind: "field-renamed",
        declaration: { name: "S", number: 101 },
        field: { name: "bar", number: 0 },
        effects: [{ dimension: "source-api", breaking: true }],
      },
    ]);
    // Keeping the name but moving it to a different number: the old slot is
    // removed and a *new* field appears at the new number. A name-based
    // comparison would (wrongly) see an unchanged field.
    const renumbered = buildOk(
      singleModule(`struct S(101) { foo: string; }`),
      singleModule(`struct S(101) { removed; foo: string; }`),
    );
    expect(renumbered.verdict.wire).toBe(true);
    expect(renumbered.entries).toMatch([
      {
        changeKind: "field-added",
        declaration: { name: "S", number: 101 },
        field: { name: "foo", number: 1 },
        effects: [{ dimension: "semantic-default", breaking: false }],
      },
    ]);
  });

  it("matches records by stable number, not by name (rename keeps wire compatibility)", () => {
    const matrix = buildOk(
      singleModule(`struct Old(101) { x: int32; }`),
      singleModule(`struct New(101) { x: int32; }`),
    );
    expect(matrix.verdict).toMatch({ wire: true, sourceApi: false });
    expect(matrix.entries).toMatch([
      {
        changeKind: "record-renamed",
        declaration: { name: "New", number: 101 },
        field: null,
      },
    ]);
  });

  it("recoverable failure: invalid input is rejected in the existing error layering, retry is stable, no cache leaks", () => {
    const before = compileOk(
      new Map([["m.skir", `struct S(101) { x: int32; }`]]),
    );
    // Mid-flow failure: the "after" schema does not compile.
    const broken = ModuleSet.compile(
      new Map([["m.skir", `struct S(101) { x: int32`]]),
      "no-cache",
      "strict",
    );
    expect(broken.errors.length > 0).toBe(true);
    const failure: CompatibilityMatrixResult = buildCompatibilityMatrix({
      before,
      after: broken,
    });
    expect(failure.kind).toBe("invalid-input");
    if (failure.kind !== "invalid-input") {
      throw new Error("expected invalid-input");
    }
    expect(failure.side).toBe("after");
    // The rejection uses the existing SkirError layering: a token with
    // module path and line info, plus an expectation or message.
    const firstError = failure.errors[0]!;
    expect(firstError.token.line.modulePath).toBe("m.skir");
    expect(
      firstError.expected !== undefined || firstError.message !== undefined,
    ).toBe(true);
    // The failed module set is not half-updated: it still reports its errors.
    expect(broken.errors.length > 0).toBe(true);

    // Retry with the same "before" input and a fixed "after" input, once
    // reusing the failed module set as the compilation cache, once without.
    const fixedSource = new Map([
      ["m.skir", `struct S(101) { x: int32; nick: string?; }`],
    ]);
    const afterFresh = compileOk(fixedSource);
    const afterCached = compileOk(fixedSource, broken);
    const matrixFresh = buildOk(before, afterFresh);
    const matrixCached = buildOk(before, afterCached);
    // The successful results carry no cache, counter or temporary state
    // left behind by the failed call.
    expect(JSON.stringify(matrixCached)).toBe(JSON.stringify(matrixFresh));
    expect(matrixFresh.entries).toMatch([
      { changeKind: "field-added", field: { name: "nick", number: 1 } },
    ]);
    // Repeating the whole sequence yields the same result again.
    const matrixAgain = buildOk(before, compileOk(fixedSource));
    expect(JSON.stringify(matrixAgain)).toBe(JSON.stringify(matrixFresh));
  });
});

function singleModule(sourceCode: string): ModuleSet {
  return compileOk(new Map([["module.skir", sourceCode]]));
}

function compileOk(
  modulePathToSourceCode: Map<string, string>,
  cache: ModuleSet | "no-cache" = "no-cache",
): ModuleSet {
  const moduleSet = ModuleSet.compile(modulePathToSourceCode, cache, "strict");
  if (moduleSet.errors.length > 0) {
    const firstError = moduleSet.errors[0]!;
    const message = firstError.message ?? `expected: ${firstError.expected}`;
    throw new Error("Error while parsing module set: " + message);
  }
  return moduleSet;
}

function buildOk(before: ModuleSet, after: ModuleSet): CompatibilityMatrix {
  const result = buildCompatibilityMatrix({ before, after });
  if (result.kind !== "ok") {
    throw new Error(`expected ok, got invalid-input (${result.side})`);
  }
  return result.matrix;
}
