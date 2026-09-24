import type {
  Field,
  Method,
  Primitive,
  Record,
  RecordLocation,
  ResolvedType,
  Token,
} from "skir-internal";
import { ModuleSet } from "./module_set.js";

export interface BeforeAfter<T> {
  before: T;
  after: T;
}

export type BreakingChange =
  | {
      kind: "illegal-type-change";
      expression: BeforeAfter<Expression>;
      type: BeforeAfter<ResolvedType>;
    }
  | {
      kind: "missing-slots";
      record: BeforeAfter<RecordLocation>;
      recordExpression: BeforeAfter<Expression>;
      missingRangeStart: number;
      missingRangeEnd: number;
    }
  | {
      kind: "missing-record";
      record: RecordLocation;
      recordNumber: number;
    }
  | {
      kind: "missing-method";
      method: Method;
    }
  | {
      kind: "record-kind-change";
      record: BeforeAfter<RecordLocation>;
      recordExpression: BeforeAfter<Expression>;
      recordType: BeforeAfter<"struct" | "enum">;
    }
  | {
      kind: "removed-number-reintroduced";
      record: BeforeAfter<RecordLocation>;
      recordExpression: BeforeAfter<Expression>;
      removedNumber: number;
      reintroducedAs: Token;
    }
  | {
      kind: "missing-variant";
      record: BeforeAfter<RecordLocation>;
      enumEpression: BeforeAfter<Expression>;
      variantName: Token;
      number: number;
    }
  | {
      kind: "wrapper-to-constant-variant";
      record: BeforeAfter<RecordLocation>;
      enumEpression: BeforeAfter<Expression>;
      variantName: BeforeAfter<Token>;
      number: number;
    };

export type Expression =
  | {
      kind: "request-type";
      methodName: Token;
    }
  | {
      kind: "response-type";
      methodName: Token;
    }
  | {
      kind: "record";
      recordName: Token;
    }
  | {
      kind: "item";
      arrayExpression: Expression;
    }
  | {
      kind: "optional-value";
      optionalExpression: Expression;
    }
  | {
      kind: "property";
      structExpression: Expression;
      fieldName: Token;
    }
  | {
      kind: "as-variant";
      enumExpression: Expression;
      variantName: Token;
    };

export function checkCompatibility(
  moduleSet: BeforeAfter<ModuleSet>,
): readonly BreakingChange[] {
  return new CompatibilityChecker(moduleSet).check();
}

/**
 * A dimension along which a schema change is judged. Compatibility is not a
 * single boolean: a change may break one dimension while leaving the others
 * intact.
 *
 * - "wire": serialized data written with the old schema can still be read and
 *   interpreted correctly with the new schema.
 * - "source-api": code generated from the new schema still exposes a
 *   source-compatible API to its consumers.
 * - "semantic-defaults": default values and the meaning of absent data are
 *   preserved.
 */
export type CompatibilityDimension =
  | "wire"
  | "source-api"
  | "semantic-defaults";

/** All dimensions, in a fixed, deterministic order. */
export const COMPATIBILITY_DIMENSIONS: readonly CompatibilityDimension[] = [
  "wire",
  "source-api",
  "semantic-defaults",
];

/**
 * Returns the dimensions affected by a given kind of breaking change.
 */
export function dimensionsAffectedByBreakingChange(
  kind: BreakingChange["kind"],
): readonly CompatibilityDimension[] {
  switch (kind) {
    case "illegal-type-change":
    case "missing-slots":
    case "missing-record":
    case "missing-method":
    case "record-kind-change":
    case "missing-variant": {
      return ["wire", "source-api"];
    }
    case "removed-number-reintroduced": {
      // Reusing a removed number does not remove anything from the generated
      // source API, but old payloads get misinterpreted on the wire.
      return ["wire", "semantic-defaults"];
    }
    case "wrapper-to-constant-variant": {
      return ["wire", "source-api", "semantic-defaults"];
    }
  }
}

export interface DimensionVerdict {
  readonly dimension: CompatibilityDimension;
  readonly compatible: boolean;
  readonly breakingChanges: readonly BreakingChange[];
}

/**
 * Structured result of a compatibility check. Unlike a single boolean, this
 * report keeps the verdict of each dimension separate and preserves the
 * individual breaking changes so callers can point at the exact declaration
 * and field identity responsible for a failure.
 */
export interface CompatibilityReport {
  /** True only if every dimension is compatible. */
  readonly compatible: boolean;
  readonly breakingChanges: readonly BreakingChange[];
  /** One verdict per dimension, in the order of COMPATIBILITY_DIMENSIONS. */
  readonly dimensions: readonly DimensionVerdict[];
}

export function buildCompatibilityReport(
  breakingChanges: readonly BreakingChange[],
): CompatibilityReport {
  const dimensions: DimensionVerdict[] = COMPATIBILITY_DIMENSIONS.map(
    (dimension) => {
      const relevant = breakingChanges.filter((change) =>
        dimensionsAffectedByBreakingChange(change.kind).includes(dimension),
      );
      return {
        dimension,
        compatible: relevant.length === 0,
        breakingChanges: relevant,
      };
    },
  );
  return {
    compatible: breakingChanges.length === 0,
    breakingChanges,
    dimensions,
  };
}

/**
 * Same as `checkCompatibility`, but returns a structured `CompatibilityReport`
 * instead of a bare list of breaking changes.
 */
export function checkCompatibilityReport(
  moduleSet: BeforeAfter<ModuleSet>,
): CompatibilityReport {
  return buildCompatibilityReport(checkCompatibility(moduleSet));
}

/**
 * Returns a stable, human-readable identity for a breaking change, including
 * the declaration (module path + qualified record/method name) and, when
 * applicable, the field identity (slot number + field/variant name). Two runs
 * over equivalent inputs produce the same identities regardless of module
 * enumeration order.
 */
export function getBreakingChangeIdentity(
  breakingChange: BreakingChange,
): string {
  switch (breakingChange.kind) {
    case "illegal-type-change": {
      return `type-change at ${formatExpressionIdentity(breakingChange.expression.after)}`;
    }
    case "missing-slots": {
      return `slots [${breakingChange.missingRangeStart}, ${breakingChange.missingRangeEnd}) of ${recordLocationIdentity(breakingChange.record.before)}`;
    }
    case "missing-record": {
      return `record ${recordLocationIdentity(breakingChange.record)} (#${breakingChange.recordNumber})`;
    }
    case "missing-method": {
      const { method } = breakingChange;
      return `method ${method.name.line.modulePath}:${method.name.text} (#${method.number})`;
    }
    case "record-kind-change": {
      return `record-kind of ${recordLocationIdentity(breakingChange.record.before)}`;
    }
    case "removed-number-reintroduced": {
      return `number #${breakingChange.removedNumber} of ${recordLocationIdentity(breakingChange.record.before)} reintroduced as '${breakingChange.reintroducedAs.text}'`;
    }
    case "missing-variant": {
      return `variant '${breakingChange.variantName.text}' (#${breakingChange.number}) of ${recordLocationIdentity(breakingChange.record.before)}`;
    }
    case "wrapper-to-constant-variant": {
      return `variant '${breakingChange.variantName.before.text}' (#${breakingChange.number}) of ${recordLocationIdentity(breakingChange.record.before)}`;
    }
  }
}

function recordLocationIdentity(record: RecordLocation): string {
  const qualifiedName = record.recordAncestors
    .map((ancestor) => ancestor.name.text)
    .join(".");
  return `${record.modulePath}:${qualifiedName}`;
}

function formatExpressionIdentity(expression: Expression): string {
  const token = getTokenForExpression(expression);
  const location = token.line.modulePath;
  return `${location}:${formatExpressionPath(expression)}`;
}

function formatExpressionPath(expression: Expression): string {
  switch (expression.kind) {
    case "request-type":
      return `${expression.methodName.text}(request)`;
    case "response-type":
      return `${expression.methodName.text}(response)`;
    case "record":
      return expression.recordName.text;
    case "item":
      return `${formatExpressionPath(expression.arrayExpression)}[*]`;
    case "optional-value":
      return `${formatExpressionPath(expression.optionalExpression)}?`;
    case "property":
      return `${formatExpressionPath(expression.structExpression)}.${expression.fieldName.text}`;
    case "as-variant":
      return `${formatExpressionPath(expression.enumExpression)}.as_${expression.variantName.text}`;
  }
}

class CompatibilityChecker {
  constructor(private readonly moduleSet: BeforeAfter<ModuleSet>) {}

  check(): readonly BreakingChange[] {
    for (const [, moduleBeforeResult] of this.moduleSet.before.modules) {
      const moduleBefore = moduleBeforeResult.result;
      if (moduleBefore.path.startsWith("@")) {
        continue;
      }
      for (const methodBefore of moduleBefore.methods) {
        const { number } = methodBefore;
        const methodAfter = this.moduleSet.after.findMethodByNumber(number);
        if (methodAfter === undefined) {
          this.breakingChanges.push({
            kind: "missing-method",
            method: methodBefore,
          });
        } else {
          this.checkMethod({
            before: methodBefore,
            after: methodAfter,
          });
        }
      }
      for (const recordBefore of moduleBefore.records) {
        const { recordNumber } = recordBefore.record;
        if (recordNumber !== null) {
          const recordAfter =
            this.moduleSet.after.findRecordByNumber(recordNumber);
          if (recordAfter === undefined) {
            this.breakingChanges.push({
              kind: "missing-record",
              record: recordBefore,
              recordNumber: recordNumber,
            });
          } else {
            const record: BeforeAfter<RecordLocation> = {
              before: recordBefore,
              after: recordAfter,
            };
            this.checkRecord(
              record,
              map(record, (r) => ({
                kind: "record",
                recordName: r.record.name,
              })),
            );
          }
        }
      }
    }
    return this.breakingChanges;
  }

  private checkMethod(method: BeforeAfter<Method>): void {
    this.checkType(
      map(method, (m) => m.requestType!),
      map(method, (m) => ({ kind: "request-type", methodName: m.name })),
    );
    this.checkType(
      map(method, (m) => m.responseType!),
      map(method, (m) => ({ kind: "response-type", methodName: m.name })),
    );
  }

  private checkRecord(
    record: BeforeAfter<RecordLocation>,
    recordExpression: BeforeAfter<Expression>,
  ): void {
    {
      // Avoid infinite recursion when checking recursive records.
      const recordKeys =
        record.before.record.key + ":" + record.after.record.key;
      if (this.seenRecordKeys.has(recordKeys)) {
        return;
      }
      this.seenRecordKeys.add(recordKeys);
    }
    const recordType = map(record, (r) => r.record.recordType);
    if (recordType.after !== recordType.before) {
      this.pushBreakingChange({
        kind: "record-kind-change",
        record,
        recordExpression,
        recordType,
      });
      return;
    }
    const isStruct = recordType.before === "struct";
    const { numSlotsInclRemovedNumbers } = record.before.record;
    if (
      record.after.record.numSlotsInclRemovedNumbers <
      numSlotsInclRemovedNumbers
    ) {
      this.pushBreakingChange({
        kind: "missing-slots",
        record,
        recordExpression,
        missingRangeStart: record.after.record.numSlotsInclRemovedNumbers,
        missingRangeEnd: numSlotsInclRemovedNumbers,
      });
      return;
    }
    const numberToFieldAfter = indexFields(record.after.record);
    // Check that no removed number was reintroduced.
    for (const removedNumber of record.before.record.removedNumbers) {
      const fieldAfter = numberToFieldAfter.get(removedNumber);
      if (fieldAfter) {
        this.pushBreakingChange({
          kind: "removed-number-reintroduced",
          record,
          recordExpression,
          removedNumber: removedNumber,
          reintroducedAs: fieldAfter.name,
        });
      }
    }
    const removedNumbersAfter = new Set<number>(
      record.after.record.removedNumbers,
    );
    for (const fieldBefore of record.before.record.fields) {
      const fieldAfter = numberToFieldAfter.get(fieldBefore.number);
      if (fieldAfter === undefined) {
        if (!removedNumbersAfter.has(fieldBefore.number)) {
          this.pushBreakingChange({
            kind: "missing-variant",
            record,
            enumEpression: recordExpression,
            variantName: fieldBefore.name,
            number: fieldBefore.number,
          });
        }
        continue;
      }
      if (fieldBefore.type && fieldAfter.type) {
        this.checkType(
          {
            before: fieldBefore.type,
            after: fieldAfter.type,
          },
          isStruct
            ? {
                before: {
                  kind: "property",
                  structExpression: recordExpression.before,
                  fieldName: fieldBefore.name,
                },
                after: {
                  kind: "property",
                  structExpression: recordExpression.after,
                  fieldName: fieldAfter.name,
                },
              }
            : {
                before: {
                  kind: "as-variant",
                  enumExpression: recordExpression.before,
                  variantName: fieldBefore.name,
                },
                after: {
                  kind: "as-variant",
                  enumExpression: recordExpression.after,
                  variantName: fieldAfter.name,
                },
              },
        );
      } else if (fieldBefore.type) {
        this.pushBreakingChange({
          kind: "wrapper-to-constant-variant",
          record,
          enumEpression: recordExpression,
          variantName: {
            before: fieldBefore.name,
            after: fieldAfter.name,
          },
          number: fieldBefore.number,
        });
      }
    }
  }

  private checkType(
    type: BeforeAfter<ResolvedType>,
    expression: BeforeAfter<Expression>,
  ): null {
    const illegalTypeChange: BreakingChange = {
      kind: "illegal-type-change",
      expression: expression,
      type: type,
    };
    switch (type.before.kind) {
      case "array": {
        if (type.after.kind === "array") {
          return this.checkType(
            {
              before: type.before.item,
              after: type.after.item,
            },
            map(expression, (e) => ({
              kind: "item",
              arrayExpression: e,
            })),
          );
        } else {
          this.pushBreakingChange(illegalTypeChange);
          return null;
        }
      }
      case "optional": {
        if (type.after.kind === "optional") {
          return this.checkType(
            {
              before: type.before.other,
              after: type.after.other,
            },
            map(expression, (e) => ({
              kind: "optional-value",
              optionalExpression: e,
            })),
          );
        } else {
          this.pushBreakingChange(illegalTypeChange);
          return null;
        }
      }
      case "record": {
        if (type.after.kind === "record") {
          const record: BeforeAfter<RecordLocation> = {
            before: this.moduleSet.before.recordMap.get(type.before.key)!,
            after: this.moduleSet.after.recordMap.get(type.after.key)!,
          };
          this.checkRecord(record, expression);
          return null;
        } else {
          this.pushBreakingChange(illegalTypeChange);
          return null;
        }
      }
      case "primitive": {
        if (
          type.after.kind !== "primitive" ||
          !primitiveTypesAreCompatible({
            before: type.before.primitive,
            after: type.after.primitive,
          })
        ) {
          this.pushBreakingChange(illegalTypeChange);
        }
        return null;
      }
    }
  }

  private pushBreakingChange(breakingChange: BreakingChange): void {
    const token = getTokenForBreakingChange(breakingChange);
    if (token === null) {
      return;
    }
    let tokenBreakingChangeKinds = this.tokenToBreakingChangeKinds.get(token);
    if (tokenBreakingChangeKinds === undefined) {
      tokenBreakingChangeKinds = new Set();
      this.tokenToBreakingChangeKinds.set(token, tokenBreakingChangeKinds);
    }
    if (tokenBreakingChangeKinds.has(breakingChange.kind)) {
      return;
    }
    tokenBreakingChangeKinds.add(breakingChange.kind);
    this.breakingChanges.push(breakingChange);
  }

  private readonly breakingChanges: BreakingChange[] = [];
  // This map helps avoid reporting multiple variants of the same breaking
  // change on the same token multiple times.
  private readonly tokenToBreakingChangeKinds = new Map<
    Token,
    Set<BreakingChange["kind"]>
  >();
  // Helps avoid infinite recursion when checking recursive records.
  private readonly seenRecordKeys = new Set<string>();
}

export function getTokenForBreakingChange(
  breakingChange: BreakingChange,
): Token | null {
  switch (breakingChange.kind) {
    case "illegal-type-change": {
      return getTokenForExpression(breakingChange.expression.after);
    }
    case "missing-slots":
    case "record-kind-change":
    case "wrapper-to-constant-variant": {
      return breakingChange.record.after.record.name;
    }
    case "missing-variant": {
      return breakingChange.record.after.record.name;
    }
    case "removed-number-reintroduced": {
      return breakingChange.reintroducedAs;
    }
    case "missing-record":
    case "missing-method": {
      return null;
    }
  }
}

function getTokenForExpression(expression: Expression): Token {
  switch (expression.kind) {
    case "item": {
      return getTokenForExpression(expression.arrayExpression);
    }
    case "optional-value": {
      return getTokenForExpression(expression.optionalExpression);
    }
    case "property": {
      return expression.fieldName;
    }
    case "as-variant": {
      return expression.variantName;
    }
    case "record": {
      return expression.recordName;
    }
    case "request-type": {
      return expression.methodName;
    }
    case "response-type": {
      return expression.methodName;
    }
  }
}

function primitiveTypesAreCompatible(type: BeforeAfter<Primitive>): boolean {
  switch (type.before) {
    case "bool":
      return (
        type.after === "bool" ||
        type.after === "int32" ||
        type.after === "int64" ||
        type.after === "hash64"
      );
    case "int32":
      return type.after === "int32" || type.after === "int64";
    case "float32":
    case "float64":
      return type.after === "float32" || type.after === "float64";
    case "timestamp":
    case "string":
    case "bytes":
    case "int64":
    case "hash64":
      return type.after === type.before;
  }
}

function indexFields(record: Record): Map<number, Field> {
  const result = new Map<number, Field>();
  for (const field of record.fields) {
    result.set(field.number, field);
  }
  return result;
}

function map<T, U>(
  beforeAfter: BeforeAfter<T>,
  fn: (value: T) => U,
): BeforeAfter<U> {
  return {
    before: fn(beforeAfter.before),
    after: fn(beforeAfter.after),
  };
}
