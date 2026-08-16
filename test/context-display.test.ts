/**
 * Hover is the library's primary interface: the accumulated context type
 * is what a reader consults to answer "what can I reach on `ctx`?". Every
 * context-widening method composes its result as
 * `Omit<Ctx, Name> & Record<Name, Out>`, and unwrapped that composition
 * is what an editor prints — nesting one layer deeper per chained call.
 * `Simplify` resolves it to a plain object.
 *
 * Structural assertions (`expectTypeOf`) can't catch a regression here:
 * the wrapped and unwrapped forms are mutually assignable, and only the
 * rendering differs. So this file asks the compiler directly, via
 * `checker.typeToString` on the fixture's builder type arguments — the
 * same string the editor shows.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ── Compiler API ────────────────────────────────────────────────────
//
// Loaded through `createRequire` against a hand-written interface rather
// than `import ts from 'typescript'`, in the same spirit as
// `asl-validator.d.ts`. The reason is the `typecheck-matrix` job: it
// runs `tsc --noEmit` against `typescript@latest`, which is now the 7.x
// native port, and that package's types resolve to a version shim with
// no `createProgram` on it. Typing the slice we drive keeps this file
// compiling on both compiler generations, and the matrix keeps testing
// what it is for — the library's types, not this harness. Only `tsc`
// runs there; the tests themselves always execute against the pinned
// `typescript` devDependency, which is a real 5.x compiler.

type Node = object;
type SourceFile = object;
type TsType = object;
type Diagnostic = object;

interface TsSymbol {
  readonly valueDeclaration?: Node;
  getName(): string;
}

interface TypeChecker {
  getSymbolAtLocation(node: Node): TsSymbol | undefined;
  getExportsOfModule(symbol: TsSymbol): TsSymbol[];
  getTypeOfSymbolAtLocation(symbol: TsSymbol, node: Node): TsType;
  getTypeArguments(type: TsType): readonly TsType[];
  typeToString(type: TsType, enclosing?: Node, flags?: number): string;
}

interface Program {
  getTypeChecker(): TypeChecker;
  getSourceFile(fileName: string): SourceFile | undefined;
  getSemanticDiagnostics(file?: SourceFile): readonly Diagnostic[];
  getSyntacticDiagnostics(file?: SourceFile): readonly Diagnostic[];
}

interface CompilerApi {
  ScriptTarget: { ES2022: number };
  ModuleKind: { NodeNext: number };
  ModuleResolutionKind: { NodeNext: number };
  TypeFormatFlags: { NoTruncation: number };
  createProgram(
    rootNames: readonly string[],
    options: Record<string, unknown>,
  ): Program;
  formatDiagnostics(
    diagnostics: readonly Diagnostic[],
    host: {
      getCanonicalFileName(fileName: string): string;
      getCurrentDirectory(): string;
      getNewLine(): string;
    },
  ): string;
}

const ts = createRequire(import.meta.url)('typescript') as CompilerApi;

const FIXTURE = fileURLToPath(
  new URL('./fixtures/context-display.ts', import.meta.url),
);

/**
 * Type-check the fixture once and render the `Ctx` type argument of each
 * exported `SequenceBuilder` binding.
 */
function renderFixtureContexts(): Map<string, string> {
  const program = ts.createProgram([FIXTURE], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(FIXTURE);
  if (!source) throw new Error(`fixture not in program: ${FIXTURE}`);

  // A fixture that stopped compiling would still yield renderable types,
  // just degraded ones — fail loudly instead of asserting on those.
  const diagnostics = [
    ...program.getSemanticDiagnostics(source),
    ...program.getSyntacticDiagnostics(source),
  ];
  if (diagnostics.length > 0) {
    throw new Error(
      `fixture does not type-check:\n${ts.formatDiagnostics(diagnostics, {
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => '\n',
      })}`,
    );
  }

  const rendered = new Map<string, string>();
  for (const symbol of checker.getExportsOfModule(
    checker.getSymbolAtLocation(source)!,
  )) {
    const declaration = symbol.valueDeclaration;
    if (!declaration) continue;
    const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
    const [ctx] = checker.getTypeArguments(type);
    if (!ctx) continue;
    rendered.set(
      symbol.getName(),
      checker.typeToString(ctx, undefined, ts.TypeFormatFlags.NoTruncation),
    );
  }
  return rendered;
}

describe('accumulated context rendering', () => {
  // One program for the whole file — createProgram is the expensive part.
  const contexts = renderFixtureContexts();

  const render = (name: string): string => {
    const value = contexts.get(name);
    if (value === undefined) {
      throw new Error(
        `fixture has no export "${name}" (have: ${[...contexts.keys()].join(', ')})`,
      );
    }
    return value;
  };

  it('renders a single task as a plain object, not Omit & Record', () => {
    expect(render('afterOneTask')).toBe(
      '{ key: string; bucket: string; loadFile: { fileUpload: { id: string; filename: string; }; }; }',
    );
  });

  it('does not nest a layer per chained task', () => {
    const rendered = render('afterThreeTasks');
    expect(rendered).not.toContain('Omit<');
    expect(rendered).not.toContain('Record<');
    // Every accumulated key is reachable at the top level of the render.
    for (const key of ['key', 'bucket', 'loadFile', 'second', 'third']) {
      expect(rendered).toContain(`${key}: `);
    }
  });

  it('renders pass, customTask, map and parallel the same way', () => {
    expect(render('afterPass')).toBe(
      '{ key: string; bucket: string; reshape: { id: string; }; }',
    );
    expect(render('afterCustomTask')).toBe(
      '{ key: string; bucket: string; job: { JobId: string; }; }',
    );
    expect(render('afterMap')).toBe(
      '{ scenes: { id: string; }[]; processScenes: { scene: { id: string; }; echo: { id: string; }; }[]; }',
    );
    expect(render('afterParallel')).toBe(
      '{ key: string; bucket: string; fanOut: [{ key: string; bucket: string; left: { a: string; }; }, { key: string; bucket: string; right: { b: string; }; }]; }',
    );
  });

  it('shows an overwritten key once, with the later type', () => {
    // The `Omit<Ctx, Name>` the simplification wraps is what makes this
    // last-write-wins rather than `{ old: string } & { fresh: number }`.
    expect(render('afterOverwrite')).toBe(
      '{ key: string; bucket: string; slot: { fresh: number; }; }',
    );
  });
});
