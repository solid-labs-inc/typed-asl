/**
 * Chain-length regression guard (#14).
 *
 * The builder used to fold each state into the context as it went —
 * `Omit<Ctx, Name> & Record<Name, Out>` — which made the context at step
 * N a mapped type wrapping step N-1's. That stack costs `2^N` to
 * resolve: instantiations doubled with every added call, and TypeScript
 * bailed with TS2589 at the 17th, so a 40-state machine could not be
 * written at all.
 *
 * `expectTypeOf` cannot guard this. The failure is a compiler
 * diagnostic, not a wrong type — past the ceiling the context degrades
 * to `any` and structural assertions happily pass. So this file compiles
 * the fixture through the compiler API and asserts on the diagnostics,
 * then reads back the accumulated context to prove the chain still
 * carries real types rather than having collapsed.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Loaded via `createRequire` against a hand-written interface for the
// same reason as `context-display.test.ts` — see the note there.
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
  new URL('./fixtures/long-chain.ts', import.meta.url),
);

interface Compiled {
  diagnostics: string;
  context: string;
}

function compileFixture(): Compiled {
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

  const raw = [
    ...program.getSemanticDiagnostics(source),
    ...program.getSyntacticDiagnostics(source),
  ];
  const diagnostics =
    raw.length === 0
      ? ''
      : ts.formatDiagnostics(raw, {
          getCanonicalFileName: (f) => f,
          getCurrentDirectory: () => process.cwd(),
          getNewLine: () => '\n',
        });

  const [symbol] = checker
    .getExportsOfModule(checker.getSymbolAtLocation(source)!)
    .filter((s) => s.getName() === 'longChain');
  const type = checker.getTypeOfSymbolAtLocation(
    symbol,
    symbol.valueDeclaration!,
  );
  const [ctx] = checker.getTypeArguments(type);
  return {
    diagnostics,
    context: checker.typeToString(
      ctx,
      undefined,
      ts.TypeFormatFlags.NoTruncation,
    ),
  };
}

describe('long chains (#14)', () => {
  // One program for the file — createProgram is the expensive part.
  const compiled = compileFixture();

  it('type-checks a 40-state chain without TS2589', () => {
    // Asserted on the whole diagnostic text so a failure names the
    // error rather than just reporting a count mismatch.
    expect(compiled.diagnostics).toBe('');
  });

  it('still carries real types that far down the chain', () => {
    // Past the old ceiling the context degraded rather than erroring
    // cleanly, so prove the accumulated keys are actually there and
    // typed — a collapsed `any` would pass a diagnostics check alone.
    expect(compiled.context).toContain('step0: { fileUpload:');
    expect(compiled.context).toContain('step39: { fileUpload:');
    expect(compiled.context).toContain(
      'final: { first: string; last: string; size: number; bucket: string; }',
    );
  });

  it('renders as a plain object, not builder machinery', () => {
    // The #13 guarantee has to survive the new representation: no
    // `ContextOf<…>`, `Omit<…>` or `Record<…>` on the surface.
    expect(compiled.context.startsWith('{')).toBe(true);
    expect(compiled.context).not.toContain('ContextOf<');
    expect(compiled.context).not.toContain('Omit<');
    expect(compiled.context).not.toContain('Record<');
  });
});
