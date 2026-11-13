/**
 * Public API of the package. Everything exported here is part of the published surface —
 * keep explicit return types (required by `isolatedDeclarations` for fast .d.ts generation).
 */

export interface GreetOptions {
  /** Shout the greeting. */
  loud?: boolean;
}

export function greet(name: string, options: GreetOptions = {}): string {
  const message = `Hello, ${name}!`;
  return options.loud ? message.toUpperCase() : message;
}
