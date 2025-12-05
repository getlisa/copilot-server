// src/middlewares/withValidatedRequest.ts
import { Response, NextFunction, RequestHandler } from 'express';
import { ValidatedRequest } from './validate';

export const withValidatedRequest =
  <T extends ValidatedRequest<any>>(
    handler: (req: T, res: Response, next?: NextFunction) => any,
  ): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(handler(req as T, res, next)).catch(next);
  };
