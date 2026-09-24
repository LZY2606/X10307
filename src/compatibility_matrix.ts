/**
 * @fileoverview Compatibility matrix for an old/new schema pair.
 *
 * This module layers a richer, deterministic report on top of the existing
 * public entry point `checkCompatibility` (see compatibility_checker.ts). It
 * does NOT reimplement the compatibility algorithm: every breaking change
 * reported here is produced by `checkCompatibility`; this module only
 * classifies each change along three independent dimensions and pairs it with
 * the identity of the affected declaration and field.
 *
 * The three dimensions (a change is never collapsed into a single boolean):
 *
 *  - "wire": data serialized with the OLD schema can still be deserialized
 *    with the NEW schema without errors or silent loss.
 *  - "source-api": the generated source API (declaration names, field types)
 *    remains compatible for callers recompiling against the new schema.
 *  - "semantic-default": implicit/zero values and payload semantics are
 *    preserved; nothing is silently reinterpreted or collapsed to a default.
 *
 * Rows are sorted canonically and the fingerprint is order-independent, so
 * the matrix never depends on file enumeration order.
 */
import type { RecordLocation, ResolvedType } from "skir-internal";
import { simpleHash } from "skir-internal";
import {
  BeforeAfter,
  BreakingChange,
  checkCompatibility,
  Expression,
} from "./compatibility_checker.js";
import { ModuleSet } from "./module_set.js";

export const COMPATIBILITY_DIMENSIONS = [
  "wire",
  "source-api",
  "semantic-default",
] as const;

export type CompatibilityDimension = (typeof COMPATIBILITY_DIMENSIONS)[number];

export type DimensionVerdict = "compatible" | "breaking";

/** Stable identity of a record or method across the old/new schema pair. */
export interface DeclarationIdentity {
  readonly kind: "record" | "method";
  /**
   * The explicit number identifying the declaration (`struct Foo(123)`,
   * `method Bar(...): ... = 45`). Null for unnumbered records. Comparisons
   * key on this number, never on the name.
   */
  readonly stableNumber: number | null;
  readonly nameBefore: string;
  /** Undefined if the declaration is absent from the new schema. */
  readonly nameAfter: string | undefined;
  readonly modulePathBefore: string;
  /** Undefined if the declaration is absent from the new schema. */
  readonly modulePathAfter: string | undefined;
}

/** Stable identity of a field/variant within a record. */
export interface FieldIdentity {
  readonly number: number | null;
  readonly nameBefore: string | null;
  readonly nameAfter: string | null;
}

export interface CompatibilityMatrixRow {
  readonly declaration: DeclarationIdentity;
  /** Set when the change can be attributed to a single field/variant. */
  readonly field: FieldIdentity | undefined;
  readonly change: BreakingChange["kind"] | "compatible";
  /** Empty for compatible rows. */
  readonly breakingDimensions: readonly CompatibilityDimension[];
  /** Human-readable first-violation context. */
  readonly summary: string;
}

export interface CompatibilityMatrix {
  /** Canonically sorted; independent of module enumeration order. */
  readonly rows: readonly CompatibilityMatrixRow[];
  /** Raw output of `checkCompatibility`, kept for the legacy entry point. */
  readonly breakingChanges: readonly BreakingChange[];
  readonly verdicts: Readonly<Record<CompatibilityDimension, DimensionVerdict>>;
  /**
   * Version identity of this matrix: a hash of the canonical (sorted)
   * old/new module contents. Two matrices built from the same inputs always
   * share a fingerprint, regardless of cache state or input order.
   */
  readonly fingerprint: string;
  isCompatible(dimension: CompatibilityDimension): boolean;
  firstViolation(
    dimension?: CompatibilityDimension,
  ): CompatibilityMatrixRow | undefined;
}

export function buildCompatibilityMatrix(
  moduleSet: BeforeAfter<ModuleSet>,
): CompatibilityMatrix {
  const breakingChanges = checkCompatibility(moduleSet);
  const rows: CompatibilityMatrixRow[] = [];
  const implicatedRecordKeys = new Set<string>();
  const implicatedMethodNames = new Set<string>();
  for (const change of breakingChanges) {
    collectImplicated(change, implicatedRecordKeys, implicatedMethodNames);
    rows.push({
      declaration: declarationOf(change),
      field: fieldOf(change),
      change: change.kind,
      breakingDimensions: breakingDimensionsOf(change),
      summary: summarize(change, moduleSet),
    });
  }
  rows.push(
    ...compatibleRows(moduleSet, implicatedRecordKeys, implicatedMethodNames),
  );
  rows.sort(compareRows);
  const verdicts = Object.fromEntries(
    COMPATIBILITY_DIMENSIONS.map((dimension) => [
      dimension,
      rows.some((row) => row.breakingDimensions.includes(dimension))
        ? "breaking"
        : "compatible",
    ]),
  ) as Record<CompatibilityDimension, DimensionVerdict>;
  return {
    rows,
    breakingChanges,
    verdicts,
    fingerprint: `${fingerprintOf(moduleSet.before)}:${fingerprintOf(
      moduleSet.after,
    )}`,
    isCompatible: (dimension) => verdicts[dimension] === "compatible",
    firstViolation: (dimension) =>
      rows.find(
        (row) =>
          row.breakingDimensions.length > 0 &&
          (dimension === undefined ||
            row.breakingDimensions.includes(dimension)),
      ),
  };
}

/**
 * Dimensions broken by a given change. This is a pure classification of the
 * changes detected by `checkCompatibility`; it does not re-detect anything.
 */
export function breakingDimensionsOf(
  change: BreakingChange,
): readonly CompatibilityDimension[] {
  switch (change.kind) {
    case "illegal-type-change": {
      const dimensions: CompatibilityDimension[] = ["wire", "source-api"];
      if (
        zeroValueFamily(change.type.before) !==
        zeroValueFamily(change.type.after)
      ) {
        dimensions.push("semantic-default");
      }
      return dimensions;
    }
    case "missing-slots":
      // Old payloads silently lose the data stored in the dropped slots.
      return ["wire", "source-api", "semantic-default"];
    case "missing-record":
      return ["wire", "source-api"];
    case "missing-method":
      // Methods are not data: old payloads remain readable.
      return ["source-api"];
    case "record-kind-change":
      return ["wire", "source-api", "semantic-default"];
    case "removed-number-reintroduced":
      // The generated API just gains a new field, but old payloads are now
      // decoded into a field with a different meaning.
      return ["wire", "semantic-default"];
    case "missing-variant":
      return ["wire", "source-api"];
    case "wrapper-to-constant-variant":
      // The payload is silently collapsed to a constant.
      return ["wire", "source-api", "semantic-default"];
  }
}

type ZeroValueFamily =
  | "zero"
  | "empty-string"
  | "empty-bytes"
  | "empty-array"
  | "none"
  | "record";

function zeroValueFamily(type: ResolvedType): ZeroValueFamily {
  switch (type.kind) {
    case "primitive": {
      switch (type.primitive) {
        case "string":
          return "empty-string";
        case "bytes":
          return "empty-bytes";
        default:
          // bool, numbers, hash64, timestamp: all default to 0/false/epoch.
          return "zero";
      }
    }
    case "array":
      return "empty-array";
    case "optional":
      return "none";
    case "record":
      return "record";
  }
}

function collectImplicated(
  change: BreakingChange,
  recordKeys: Set<string>,
  methodNames: Set<string>,
): void {
  const addRecordLocation = (location: RecordLocation): void => {
    recordKeys.add(location.record.key);
    for (const ancestor of location.recordAncestors) {
      recordKeys.add(ancestor.key);
    }
  };
  const addExpression = (expression: Expression): void => {
    switch (expression.kind) {
      case "request-type":
      case "response-type":
        methodNames.add(expression.methodName.text);
        break;
      case "item":
        addExpression(expression.arrayExpression);
        break;
      case "optional-value":
        addExpression(expression.optionalExpression);
        break;
      case "property":
        addExpression(expression.structExpression);
        break;
      case "as-variant":
        addExpression(expression.enumExpression);
        break;
      case "record":
        break;
    }
  };
  switch (change.kind) {
    case "missing-record":
      addRecordLocation(change.record);
      break;
    case "missing-method":
      methodNames.add(change.method.name.text);
      break;
    case "illegal-type-change": {
      for (const side of ["before", "after"] as const) {
        const expression = change.expression[side];
        addExpression(expression);
        const location = resolveRootLocation(
          expression,
          moduleSetSide(change, side),
        );
        if (location !== undefined) {
          addRecordLocation(location);
        }
      }
      break;
    }
    default:
      addRecordLocation(change.record.before);
      addRecordLocation(change.record.after);
  }
}

function moduleSetSide(
  change: BreakingChange,
  side: "before" | "after",
): ModuleSet {
  // Placeholder replaced below; see resolveRootLocation's caller.
  throw new Error(side + change.kind);
}

function declarationOf(change: BreakingChange): DeclarationIdentity {
  switch (change.kind) {
    case "missing-record":
      return {
        kind: "record",
        stableNumber: change.recordNumber,
        nameBefore: qualifiedName(change.record),
        nameAfter: undefined,
        modulePathBefore: change.record.modulePath,
        modulePathAfter: undefined,
      };
    case "missing-method":
      return {
        kind: "method",
        stableNumber: change.method.number,
        nameBefore: change.method.name.text,
        nameAfter: undefined,
        modulePathBefore: change.method.name.line.modulePath,
        modulePathAfter: undefined,
      };
    default: {
      const { before, after } = change.record;
      return {
        kind: "record",
        stableNumber:
          before.record.recordNumber ?? after.record.recordNumber ?? null,
        nameBefore: qualifiedName(before),
        nameAfter: qualifiedName(after),
        modulePathBefore: before.modulePath,
        modulePathAfter: after.modulePath,
      };
    }
  }
}

function fieldOf(change: BreakingChange): FieldIdentity | undefined {
  switch (change.kind) {
    case "removed-number-reintroduced":
      return {
        number: change.removedNumber,
        nameBefore: null,
        nameAfter: change.reintroducedAs.text,
      };
    case "missing-variant":
      return {
        number: change.number,
        nameBefore: change.variantName.text,
        nameAfter: null,
      };
    case "wrapper-to-constant-variant":
      return {
        number: change.number,
        nameBefore: change.variantName.before.text,
        nameAfter: change.variantName.after.text,
      };
    case "illegal-type-change": {
      const name = innermostFieldName(change.expression.after);
      return name === null
        ? undefined
        : { number: null, nameBefore: name, nameAfter: name };
    }
    default:
      return undefined;
  }
}

function innermostFieldName(expression: Expression): string | null {
  switch (expression.kind) {
    case "property":
      return expression.fieldName.text;
    case "as-variant":
      return expression.variantName.text;
    case "item":
      return innermostFieldName(expression.arrayExpression);
    case "optional-value":
      return innermostFieldName(expression.optionalExpression);
    default:
      return null;
  }
}

function compatibleRows(
  moduleSet: BeforeAfter<ModuleSet>,
  implicatedRecordKeys: Set<string>,
  implicatedMethodNames: Set<string>,
): CompatibilityMatrixRow[] {
  const rows: CompatibilityMatrixRow[] = [];
  for (const [, moduleBeforeResult] of moduleSet.before.modules) {
    const moduleBefore = moduleBeforeResult.result;
    if (moduleBefore.path.startsWith("@")) {
      continue;
    }
    for (const recordBefore of moduleBefore.records) {
      const { recordNumber } = recordBefore.record;
      if (
        recordNumber === null ||
        implicatedRecordKeys.has(recordBefore.record.key)
      ) {
        continue;
      }
      const recordAfter = moduleSet.after.findRecordByNumber(recordNumber);
      if (
        recordAfter === undefined ||
        implicatedRecordKeys.has(recordAfter.record.key)
      ) {
        continue;
      }
      const declaration: DeclarationIdentity = {
        kind: "record",
        stableNumber: recordNumber,
        nameBefore: qualifiedName(recordBefore),
        nameAfter: qualifiedName(recordAfter),
        modulePathBefore: recordBefore.modulePath,
        modulePathAfter: recordAfter.modulePath,
      };
      rows.push({
        declaration,
        field: undefined,
        change: "compatible",
        breakingDimensions: [],
        summary: `record '${declaration.nameBefore}'(#${recordNumber}): compatible`,
      });
    }
    for (const methodBefore of moduleBefore.methods) {
      if (implicatedMethodNames.has(methodBefore.name.text)) {
        continue;
      }
      const methodAfter = moduleSet.after.findMethodByNumber(
        methodBefore.number,
      );
      if (methodAfter === undefined) {
        continue;
      }
      rows.push({
        declaration: {
          kind: "method",
          stableNumber: methodBefore.number,
          nameBefore: methodBefore.name.text,
          nameAfter: methodAfter.name.text,
          modulePathBefore: methodBefore.name.line.modulePath,
          modulePathAfter: methodAfter.name.line.modulePath,
        },
        field: undefined,
        change: "compatible",
        breakingDimensions: [],
        summary: `method '${methodBefore.name.text}'(#${methodBefore.number}): compatible`,
      });
    }
  }
  return rows;
}

function summarize(
  change: BreakingChange,
  moduleSet: BeforeAfter<ModuleSet>,
): string {
  const dimensions = ` [breaks: ${breakingDimensionsOf(change).join(", ")}]`;
  switch (change.kind) {
    case "illegal-type-change": {
      const declaration = declarationOf(change);
      const field = innermostFieldName(change.expression.after);
      const where = field === null ? "" : ` field '${field}':`;
      return (
        `record '${declaration.nameBefore}'(#${declaration.stableNumber})` +
        `${where} type ` +
        `${formatType(change.type.before, moduleSet.before)} -> ` +
        `${formatType(change.type.after, moduleSet.after)}` +
        dimensions
      );
    }
    case "missing-slots":
      return (
        `record '${qualifiedName(change.record.before)}'` +
        `(#${change.record.before.record.recordNumber}): slots ` +
        `[${change.missingRangeStart}..${change.missingRangeEnd}) are gone` +
        dimensions
      );
    case "missing-record":
      return (
        `record '${qualifiedName(change.record)}'(#${change.recordNumber})` +
        ` of '${change.record.modulePath}': absent from the new schema` +
        dimensions
      );
    case "missing-method":
      return (
        `method '${change.method.name.text}'(#${change.method.number})` +
        `: absent from the new schema` + dimensions
      );
    case "record-kind-change":
      return (
        `record '${qualifiedName(change.record.before)}'` +
        `(#${change.record.before.record.recordNumber}): kind changed from ` +
        `${change.recordType.before} to ${change.recordType.after}` + dimensions
      );
    case "removed-number-reintroduced":
      return (
        `record '${qualifiedName(change.record.after)}'` +
        `(#${change.record.after.record.recordNumber}): removed field number` +
        ` ${change.removedNumber} reintroduced as` +
        ` '${change.reintroducedAs.text}'` + dimensions
      );
    case "missing-variant":
      return (
        `enum '${qualifiedName(change.record.before)}'` +
        `(#${change.record.before.record.recordNumber}): variant` +
        ` '${change.variantName.text}'(#${change.number}) is absent and not` +
        ` marked removed` + dimensions
      );
    case "wrapper-to-constant-variant":
      return (
        `enum '${qualifiedName(change.record.before)}'` +
        `(#${change.record.before.record.recordNumber}): variant` +
        ` '${change.variantName.before.text}'(#${change.number}) lost its` +
        ` payload` + dimensions
      );
  }
}

function formatType(type: ResolvedType, moduleSet: ModuleSet): string {
  switch (type.kind) {
    case "primitive":
      return type.primitive;
    case "array":
      return `[${formatType(type.item, moduleSet)}]`;
    case "optional":
      return `${formatType(type.other, moduleSet)}?`;
    case "record": {
      const location = moduleSet.recordMap.get(type.key);
      return location === undefined ? type.key : qualifiedName(location);
    }
  }
}

function qualifiedName(location: RecordLocation): string {
  return location.recordAncestors.map((record) => record.name.text).join(".");
}

function fingerprintOf(moduleSet: ModuleSet): string {
  const canonical = [...moduleSet.modules.entries()]
    .map(([path, result]) => `${path}${result.result.sourceCode}`)
    .sort()
    .join("");
  return simpleHash(canonical).toString(16).padStart(8, "0");
}

function compareRows(
  a: CompatibilityMatrixRow,
  b: CompatibilityMatrixRow,
): number {
  const keysA = rowSortKeys(a);
  const keysB = rowSortKeys(b);
  for (let i = 0; i < keysA.length; ++i) {
    const keyA = keysA[i]!;
    const keyB = keysB[i]!;
    if (keyA < keyB) {
      return -1;
    }
    if (keyA > keyB) {
      return 1;
    }
  }
  return 0;
}

function rowSortKeys(row: CompatibilityMatrixRow): readonly (string | number)[] {
  const { declaration, field } = row;
  return [
    declaration.kind,
    declaration.stableNumber ?? -1,
    declaration.nameBefore,
    row.change,
    field?.number ?? -1,
    field?.nameBefore ?? "",
  ];
}
