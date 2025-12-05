import { Request, Response, NextFunction } from "express";
import { ZodObject, ZodRawShape, z } from "zod";
import logger from "../../lib/logger";

export type ValidatedRequest<T extends ZodObject<ZodRawShape>> = Request & {
  validated: z.infer<T>;
};

export const validate = <T extends ZodObject<any>>(schema: T) =>
  (req: Request, res: Response, next: NextFunction) => {
    const logContext = {
      method: req.method,
      path: req.path,
      body: req.body,
      params: req.params,
      query: req.query,
    };

    logger.debug("Validating request", logContext);

    const result = schema.safeParse({
      body: req.body,
      params: req.params,
      query: req.query,
    });

    if (!result.success) {
      const errors = result.error.errors.map((error) => ({
        path: error.path.join("."),
        message: error.message,
        code: error.code,
      }));

      logger.warn("Validation failed", {
        ...logContext,
        errors,
        errorCount: errors.length,
      });

      return res.status(400).json({
        success: false,
        error: {
          status: 400,
          message: "Validation error",
          details: errors,
        },
      });
    }

    logger.debug("Validation passed", { method: req.method, path: req.path });
    (req as ValidatedRequest<T>).validated = result.data;
    next();
  };
