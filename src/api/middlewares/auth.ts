import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { jwtConfig } from '../../config/jwt';
import logger from '../../lib/logger';

export interface RequestWithUser extends Request {
  user?: {
    userId: string;
    email: string;
    role: string;
    companyId: number;
  };
}

/**
 * Authentication middleware to verify JWT access token
 * Extracts token from Authorization header and validates it
 */
export async function authMiddleware(req: RequestWithUser, res: Response, next: NextFunction) {
  const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const logContext = { 
    requestId, 
    method: req.method, 
    path: req.path,
    ip: req.ip 
  };

  // DEV BYPASS: Skip auth in development when X-Dev-Bypass header is set
  if (process.env.NODE_ENV !== 'production' && req.headers['x-dev-bypass'] === 'true') {
    req.user = {
      userId: req.headers['x-user-id'] as string || 'dev-user-123',
      email: req.headers['x-user-email'] as string || 'dev@test.com',
      role: req.headers['x-user-role'] as string || 'technician',
      companyId: parseInt(req.headers['x-company-id'] as string) || 1,
    };
    logger.info('Auth bypassed (dev mode)', { ...logContext, user: req.user });
    return next();
  }

  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      logger.warn('Auth failed: Missing authorization header', logContext);
      return res.status(401).json({
        data: null,
        error: {
          status: 401,
          message: 'Missing authorization header',
        },
      });
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      logger.warn('Auth failed: Invalid header format', { 
        ...logContext, 
        headerFormat: parts[0],
        partsCount: parts.length 
      });
      return res.status(401).json({
        data: null,
        error: {
          status: 401,
          message: 'Invalid authorization header format. Expected: Bearer <token>',
        },
      });
    }

    const token = parts[1];
    logger.debug('Verifying JWT token', { ...logContext, tokenPreview: `${token.substring(0, 20)}...` });

    // Verify token
    const decoded = jwt.verify(token, String(jwtConfig.accessSecret)) as any;

    // Check token type
    if (decoded.type !== 'access') {
      logger.warn('Auth failed: Invalid token type', { 
        ...logContext, 
        tokenType: decoded.type,
        expectedType: 'access' 
      });
      return res.status(401).json({
        data: null,
        error: {
          status: 401,
          message: 'Invalid token type',
        },
      });
    }

    // Attach user info to request
    req.user = {
      userId: decoded.userId,
      email: decoded.email,
      role: decoded.role,
      companyId: decoded.companyId,
    };

    logger.info('Auth successful', { 
      ...logContext, 
      userId: req.user.userId,
      role: req.user.role 
    });

    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      logger.warn('Auth failed: Invalid JWT', { 
        ...logContext, 
        errorName: error.name,
        errorMessage: error.message 
      });
      return res.status(401).json({
        data: null,
        error: {
          status: 401,
          message: 'Invalid access token',
        },
      });
    }

    if (error instanceof jwt.TokenExpiredError) {
      logger.warn('Auth failed: Token expired', { 
        ...logContext, 
        expiredAt: error.expiredAt 
      });
      return res.status(401).json({
        data: null,
        error: {
          status: 401,
          message: 'Access token expired',
        },
      });
    }

    logger.error('Auth middleware unexpected error', { 
      ...logContext, 
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    return res.status(500).json({
      data: null,
      error: {
        status: 500,
        message: 'Internal server error',
      },
    });
  }
}
