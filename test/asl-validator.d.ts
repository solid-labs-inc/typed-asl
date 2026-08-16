// asl-validator ships no type declarations; this covers the slice we use.
declare module 'asl-validator' {
  interface AslValidationError {
    'Error code': string;
    Message: string;
    schemaError?: { instancePath: string; schemaPath: string };
  }

  interface AslValidationResult {
    isValid: boolean;
    errors: AslValidationError[];
  }

  function aslValidator(definition: unknown): AslValidationResult;

  export = aslValidator;
}
