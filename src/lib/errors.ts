// `(err as Error).message` is an unsafe type assertion — err from a catch
// clause is `unknown`, and asserting it's an Error isn't guaranteed (code
// can throw non-Error values). `instanceof` is a real type guard instead.
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
