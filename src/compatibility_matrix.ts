import type {
  Field,
  Method,
  RecordLocation,
  SkirError,
  Token,
} from "skir-internal";
import {
  BeforeAfter,
  BreakingChange,
  Expression,
  checkCompatibility,
} from "./compatibility_checker.js";
import { getShortMessageForBreakingChange } from "./error_renderer.js";
import { ModuleSet } from "./module_set.js";

/**
 * The three dimensions along which a schema change is classified.
 *
 * - `wire`: can readers and writers running different versions of the schema
 *   still exchange payloads?
 * - `source-api`: does the generated source API (class names, method names,
 *   field accessors) remain source-compatible?
 * - `semantic-default`: does the change alter the default values observed
 *   when decoding payloads written before the change?
 */
export type CompatibilityDimension =
  | "wire"
  | "source-api"
  | "semantic-default";

export interface DimensionEffect {
  readonly dimension: CompatibilityDimension;
  readonly breaking: boolean;
}

export interface DeclarationIdentity {
  readonly kind: "record" | "method";
  readonly name: string;
  /** Stable number of the record or method, if it has one. */
  readonly number: number | null;
  readonly modulePath: string;
}

export interface FieldIdentity {
  readonly name: string;
  /** Stable field/variant number; this (not the name) is the field identity. */
  readonly number: number;
}

export type MatrixChangeKind =
  | BreakingChange["kind"]
  | "record-renamed"
  | "record-moved"
  | "field-renamed"
  | "field-added"
  | "variant-added"
  | "record-added"
  | "method-renamed"
  | "method-added";

export interface CompatibilityMatrixEntry {
  readonly changeKind: MatrixChangeKind;
  readonly declaration: DeclarationIdentity;
  readonly field: FieldIdentity | null;
  readonly effects: readonly DimensionEffect[];
  /**
   * The underlying wire-level breaking change reported by
   * `checkCompatibility`, if this entry corresponds to one.
   */
  readonly breakingChange: BreakingChange | null;
  readonly message: string;
}

export interface CompatibilityVerdict {
  readonly wire: boolean;
  readonly sourceApi: boolean;
  readonly semanticDefault: boolean;
}

export interface CompatibilityMatrix {
  /**
   * All detected changes, sorted deterministically by declaration identity
   * (module path, number, name) then field identity. Never depends on the
   * enumeration order of modules or declarations.
   */
  readonly entries: readonly CompatibilityMatrixEntry[];
  /**
   * Per-dimension compatibility verdict. Deliberately NOT a single boolean:
   * a change may be wire-compatible yet source-api breaking (e.g. a rename).
   */
  readonly verdict: CompatibilityVerdict;
}

export type CompatibilityMatrixResult =
  | { readonly kind: "ok"; readonly matrix: CompatibilityMatrix }
  | {
      readonly kind: "invalid-input";
      readonly side: "before" | "after";
      readonly errors: readonly SkirError[];
    };

/**
 * Builds a compatibility matrix between two versions of a schema.
 *
 * This is a pure function: it keeps no cache, counter or temporary state
 * between calls, so a failed call cannot influence subsequent calls. The
 * wire-level dimension is computed by `checkCompatibility` (the same logic
 * used by `skir snapshot`); this function only adds source-API and
 * semantic-default observations on top, matched by stable record/field
 * numbers rather than by name.
 */
export function buildCompatibilityMatrix(
  moduleSet: BeforeAfter<ModuleSet>,
): CompatibilityMatrixResult {
  for (const side of ["before", "after"] as const) {
    const errors = moduleSet[side].errors;
    if (errors.length > 0) {
      return { kind: "invalid-input", side, errors };
    }
  }
  const entries: CompatibilityMatrixEntry[] = [];
  for (const breakingChange of checkCompatibility(moduleSet)) {
    entries.push(makeWireEntry(breakingChange, moduleSet));
  }
  entries.push(...collectSourceApiAndSemanticEntries(moduleSet));
  entries.sort(compareEntries);
  return { kind: "ok", matrix: { entries, verdict: makeVerdict(entries) } };
}

const WIRE_EFFECTS: readonly DimensionEffect[] = [
  { dimension: "wire", breaking: true },
  { dimension: "source-api", breaking: true },
];
const SOURCE_API_BREAKING_EFFECTS: readonly DimensionEffect[] = [
  { dimension: "source-api", breaking: true },
];
const SOURCE_API_ADDITIVE_EFFECTS: readonly DimensionEffect[] = [
  { dimension: "source-api", breaking: false },
];
const SEMANTIC_DEFAULT_EFFECTS: readonly DimensionEffect[] = [
  { dimension: "semantic-default", breaking: false },
];

function makeWireEntry(
  breakingChange: BreakingChange,
  moduleSet: BeforeAfter<ModuleSet>,
): CompatibilityMatrixEntry {
  const { declaration, field } = identifyBreakingChange(
    breakingChange,
    moduleSet.after,
  );
  const shortMessage = getShortMessageForBreakingChange(
    breakingChange,
    moduleSet.before,
  );
  const detail =
    shortMessage ||
    (breakingChange.kind === "missing-record"
      ? "record is missing"
      : breakingChange.kind === "missing-method"
        ? "method is missing"
        : breakingChange.kind);
  return {
    changeKind: breakingChange.kind,
    declaration,
    field,
    effects: WIRE_EFFECTS,
    breakingChange,
    message: `${formatDeclaration(declaration)}${formatField(field)}: ${detail}`,
  };
}

function identifyBreakingChange(
  breakingChange: BreakingChange,
  after: ModuleSet,
): {
  declaration: DeclarationIdentity;
  field: FieldIdentity | null;
} {
  switch (breakingChange.kind) {
    case "missing-record": {
      return {
        declaration: recordDeclaration(breakingChange.record),
        field: null,
      };
    }
    case "missing-method": {
      return {
        declaration: methodDeclaration(breakingChange.method),
        field: null,
      };
    }
    case "missing-slots":
    case "record-kind-change": {
      return {
        declaration: recordDeclaration(breakingChange.record.after),
        field: null,
      };
    }
    case "missing-variant": {
      return {
        declaration: recordDeclaration(breakingChange.record.after),
        field: {
          name: breakingChange.variantName.text,
          number: breakingChange.number,
        },
      };
    }
    case "wrapper-to-constant-variant": {
      return {
        declaration: recordDeclaration(breakingChange.record.after),
        field: {
          name: breakingChange.variantName.after.text,
          number: breakingChange.number,
        },
      };
    }
    case "removed-number-reintroduced": {
      return {
        declaration: recordDeclaration(breakingChange.record.after),
        field: {
          name: breakingChange.reintroducedAs.text,
          number: breakingChange.removedNumber,
        },
      };
    }
    case "illegal-type-change": {
      return resolveExpression(breakingChange.expression.after, after);
    }
  }
}

/**
 * Resolves an expression to the declaration and field it refers to, using
 * the module path and name carried by its tokens. Field numbers are looked
 * up in the containing record so that reports carry stable field identities.
 */
function resolveExpression(
  expression: Expression,
  moduleSet: ModuleSet,
): {
  declaration: DeclarationIdentity;
  field: FieldIdentity | null;
} {
  // Collect the property/variant tokens from the outermost (deepest field)
  // to the innermost (field of the root record).
  const fieldTokens: Token[] = [];
  let root: Expression = expression;
  for (;;) {
    switch (root.kind) {
      case "item":
        root = root.arrayExpression;
        continue;
      case "optional-value":
        root = root.optionalExpression;
        continue;
      case "property":
        fieldTokens.push(root.fieldName);
        root = root.structExpression;
        continue;
      case "as-variant":
        fieldTokens.push(root.variantName);
        root = root.enumExpression;
        continue;
    }
    break;
  }
  const rootToken =
    root.kind === "record"
      ? root.recordName
      : root.kind === "request-type" || root.kind === "response-type"
        ? root.methodName
        : null;
  if (rootToken === null) {
    return {
      declaration: {
        kind: "record",
        name: "?",
        number: null,
        modulePath: "?",
      },
      field: null,
    };
  }
  const modulePath = rootToken.line.modulePath;
  const module = moduleSet.modules.get(modulePath)?.result;
  if (module === undefined) {
    return {
      declaration: {
        kind: root.kind === "record" ? "record" : "method",
        name: rootToken.text,
        number: null,
        modulePath,
      },
      field: null,
    };
  }
  if (root.kind !== "record") {
    const method = module.methods.find(
      (m) => m.name.text === rootToken.text,
    );
    return {
      declaration: method
        ? methodDeclaration(method)
        : {
            kind: "method",
            name: rootToken.text,
            number: null,
            modulePath,
          },
      field: null,
    };
  }
  let record = module.records.find(
    (r) =>
      r.recordAncestors.length === 1 && r.record.name.text === rootToken.text,
  );
  const declaration: DeclarationIdentity = record
    ? recordDeclaration(record)
    : {
        kind: "record",
        name: rootToken.text,
        number: null,
        modulePath,
      };
  // Walk the field chain from the root record to the deepest field.
  let field: Field | undefined;
  for (let i = fieldTokens.length - 1; i >= 0 && record; --i) {
    const token = fieldTokens[i]!;
    field = record.record.fields.find((f) => f.name.text === token.text);
    const fieldType = field?.type;
    record =
      fieldType?.kind === "record"
        ? moduleSet.recordMap.get(fieldType.key)
        : undefined;
  }
  return {
    declaration,
    field: field ? { name: field.name.text, number: field.number } : null,
  };
}

function collectSourceApiAndSemanticEntries(
  moduleSet: BeforeAfter<ModuleSet>,
): CompatibilityMatrixEntry[] {
  const entries: CompatibilityMatrixEntry[] = [];
  const { before, after } = moduleSet;
  for (const [, moduleResult] of before.modules) {
    const moduleBefore = moduleResult.result;
    if (moduleBefore.path.startsWith("@")) {
      continue;
    }
    for (const methodBefore of moduleBefore.methods) {
      const methodAfter = after.findMethodByNumber(methodBefore.number);
      if (
        methodAfter !== undefined &&
        methodAfter.name.text !== methodBefore.name.text
      ) {
        const declaration = methodDeclaration(methodAfter);
        entries.push({
          changeKind: "method-renamed",
          declaration,
          field: null,
          effects: SOURCE_API_BREAKING_EFFECTS,
          breakingChange: null,
          message:
            `${formatDeclaration(declaration)}: method renamed from ` +
            `'${methodBefore.name.text}'; wire identity (number) unchanged`,
        });
      }
    }
    for (const recordBefore of moduleBefore.records) {
      const { recordNumber } = recordBefore.record;
      if (recordNumber === null) {
        continue;
      }
      const recordAfter = after.findRecordByNumber(recordNumber);
      if (recordAfter === undefined) {
        continue; // Reported as a wire-level "missing-record" entry.
      }
      entries.push(
        ...diffRecord({ before: recordBefore, after: recordAfter }),
      );
    }
  }
  for (const [, moduleResult] of after.modules) {
    const moduleAfter = moduleResult.result;
    if (moduleAfter.path.startsWith("@")) {
      continue;
    }
    for (const recordAfter of moduleAfter.records) {
      const { recordNumber } = recordAfter.record;
      if (
        recordNumber !== null &&
        before.findRecordByNumber(recordNumber) === undefined
      ) {
        const declaration = recordDeclaration(recordAfter);
        entries.push({
          changeKind: "record-added",
          declaration,
          field: null,
          effects: SOURCE_API_ADDITIVE_EFFECTS,
          breakingChange: null,
          message: `${formatDeclaration(declaration)}: record added`,
        });
      }
    }
    for (const methodAfter of moduleAfter.methods) {
      if (before.findMethodByNumber(methodAfter.number) === undefined) {
        const declaration = methodDeclaration(methodAfter);
        entries.push({
          changeKind: "method-added",
          declaration,
          field: null,
          effects: SOURCE_API_ADDITIVE_EFFECTS,
          breakingChange: null,
          message: `${formatDeclaration(declaration)}: method added`,
        });
      }
    }
  }
  return entries;
}

function diffRecord(
  record: BeforeAfter<RecordLocation>,
): CompatibilityMatrixEntry[] {
  const entries: CompatibilityMatrixEntry[] = [];
  const declaration = recordDeclaration(record.after);
  const nameBefore = record.before.record.name.text;
  const nameAfter = record.after.record.name.text;
  if (nameBefore !== nameAfter) {
    entries.push({
      changeKind: "record-renamed",
      declaration,
      field: null,
      effects: SOURCE_API_BREAKING_EFFECTS,
      breakingChange: null,
      message:
        `${formatDeclaration(declaration)}: record renamed from ` +
        `'${nameBefore}'; wire identity (number) unchanged`,
    });
  }
  const modulePathBefore = record.before.modulePath;
  const modulePathAfter = record.after.modulePath;
  if (modulePathBefore !== modulePathAfter) {
    entries.push({
      changeKind: "record-moved",
      declaration,
      field: null,
      effects: SOURCE_API_BREAKING_EFFECTS,
      breakingChange: null,
      message:
        `${formatDeclaration(declaration)}: record moved from module ` +
        `'${modulePathBefore}' to '${modulePathAfter}'; wire identity ` +
        `(number) unchanged`,
    });
  }
  if (record.before.record.recordType !== record.after.record.recordType) {
    return entries; // Reported as a wire-level "record-kind-change" entry.
  }
  const isStruct = record.after.record.recordType === "struct";
  const numberToFieldBefore = indexFields(record.before.record.fields);
  const removedNumbersBefore = new Set(record.before.record.removedNumbers);
  for (const fieldAfter of record.after.record.fields) {
    const fieldBefore = numberToFieldBefore.get(fieldAfter.number);
    const field: FieldIdentity = {
      name: fieldAfter.name.text,
      number: fieldAfter.number,
    };
    if (fieldBefore === undefined) {
      if (removedNumbersBefore.has(fieldAfter.number)) {
        continue; // Reported as a wire-level "removed-number-reintroduced".
      }
      entries.push({
        changeKind: isStruct ? "field-added" : "variant-added",
        declaration,
        field,
        effects: isStruct
          ? SEMANTIC_DEFAULT_EFFECTS
          : SOURCE_API_ADDITIVE_EFFECTS,
        breakingChange: null,
        message: isStruct
          ? `${formatDeclaration(declaration)}${formatField(field)}: field ` +
            `added; payloads written before this change decode with the ` +
            `default value for this field`
          : `${formatDeclaration(declaration)}${formatField(field)}: ` +
            `variant added`,
      });
    } else if (fieldBefore.name.text !== fieldAfter.name.text) {
      entries.push({
        changeKind: "field-renamed",
        declaration,
        field,
        effects: SOURCE_API_BREAKING_EFFECTS,
        breakingChange: null,
        message:
          `${formatDeclaration(declaration)}${formatField(field)}: field ` +
          `renamed from '${fieldBefore.name.text}'; wire identity (number) ` +
          `unchanged`,
      });
    }
  }
  return entries;
}

function makeVerdict(
  entries: readonly CompatibilityMatrixEntry[],
): CompatibilityVerdict {
  const isBreaking = (dimension: CompatibilityDimension): boolean =>
    entries.some((entry) =>
      entry.effects.some(
        (effect) => effect.dimension === dimension && effect.breaking,
      ),
    );
  return {
    wire: !isBreaking("wire"),
    sourceApi: !isBreaking("source-api"),
    semanticDefault: !isBreaking("semantic-default"),
  };
}

function compareEntries(
  a: CompatibilityMatrixEntry,
  b: CompatibilityMatrixEntry,
): number {
  const keys = (entry: CompatibilityMatrixEntry): readonly (string | number)[] => [
    entry.declaration.modulePath,
    entry.declaration.number ?? -1,
    entry.declaration.name,
    entry.field?.number ?? -1,
    entry.field?.name ?? "",
    entry.changeKind,
  ];
  const keysA = keys(a);
  const keysB = keys(b);
  for (let i = 0; i < keysA.length; ++i) {
    const keyA = keysA[i]!;
    const keyB = keysB[i]!;
    if (keyA < keyB) return -1;
    if (keyA > keyB) return 1;
  }
  return 0;
}

function recordDeclaration(record: RecordLocation): DeclarationIdentity {
  return {
    kind: "record",
    name: record.record.name.text,
    number: record.record.recordNumber,
    modulePath: record.modulePath,
  };
}

function methodDeclaration(method: Method): DeclarationIdentity {
  return {
    kind: "method",
    name: method.name.text,
    number: method.number,
    modulePath: method.name.line.modulePath,
  };
}

function formatDeclaration(declaration: DeclarationIdentity): string {
  const number =
    declaration.number === null ? "" : `(${declaration.number})`;
  return `${declaration.kind} ${declaration.name}${number} in ${declaration.modulePath}`;
}

function formatField(field: FieldIdentity | null): string {
  return field === null ? "" : ` field ${field.name}(${field.number})`;
}

function indexFields(fields: readonly Field[]): Map<number, Field> {
  const result = new Map<number, Field>();
  for (const field of fields) {
    result.set(field.number, field);
  }
  return result;
}
