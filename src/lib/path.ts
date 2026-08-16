export type PathValue<T, P extends string> = P extends `$`
  ? T
  : P extends `$[${infer Rest}`
    ? PathValueRecursive<T, `[${Rest}`>
    : P extends `$.${infer Rest}`
      ? PathValueRecursive<T, `.${Rest}`>
      : unknown;

type PathValueRecursive<T, P extends string> = P extends ''
  ? T
  : P extends `.${infer Key}[${number}]${infer Rest}`
    ? Key extends keyof T
      ? T[Key] extends readonly (infer U)[]
        ? PathValueRecursive<U, Rest>
        : unknown
      : P extends `.${infer Key2}.${infer Rest2}`
        ? Key2 extends keyof T
          ? PathValueRecursive<T[Key2], `.${Rest2}`>
          : unknown
        : unknown
    : P extends `[${number}]${infer Rest}`
      ? T extends readonly (infer U)[]
        ? PathValueRecursive<U, Rest>
        : unknown
      : P extends `.${infer Key}.${infer Rest}`
        ? Key extends keyof T
          ? PathValueRecursive<T[Key], `.${Rest}`>
          : unknown
        : P extends `.${infer Key}`
          ? Key extends keyof T
            ? T[Key]
            : unknown
          : unknown;
