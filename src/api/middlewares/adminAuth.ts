import { Request, Response, NextFunction } from "express";
import logger from "../../lib/logger";

/**
 * Internal Clara-team auth for /api/v1/admin/*: a shared static token in the
 * X-Admin-Token header, compared against ADMIN_API_TOKEN. Fails closed when the env var
 * is unset. This is the PRDs' "backend mechanism" — technician JWTs are neither required
 * nor accepted here, so a technician account can never reach company configuration.
 * ponytail: shared static token; per-admin accounts if the team grows.
 */
export function adminAuth(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.ADMIN_API_TOKEN;
  const provided = req.headers["x-admin-token"];
  if (!expected || typeof provided !== "string" || provided !== expected) {
    logger.warn("Admin auth rejected", { path: req.path, hasToken: !!provided });
    return res
      .status(401)
      .json({ success: false, error: { status: 401, message: "Admin token required" } });
  }
  next();
}
