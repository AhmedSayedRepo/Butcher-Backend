// Express handlers that are `async` return a Promise, but Express's own
// handler signature expects void — that mismatch is exactly what
// @typescript-eslint/no-misused-promises and
// @typescript-eslint/strict-void-return catch, and it's not just a style
// nit: without this wrapper, a thrown/rejected error inside an async route
// handler becomes an unhandled promise rejection instead of a proper
// Express error response. This forwards it to Express's centralized
// error-handling middleware (see index.ts) via `next` instead.
import type { NextFunction, Request, Response } from 'express'

export function asyncHandler<Req extends Request = Request>(
  handler: (req: Req, res: Response) => Promise<void>
): (req: Req, res: Response, next: NextFunction) => void {
  return (req: Req, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next)
  }
}
