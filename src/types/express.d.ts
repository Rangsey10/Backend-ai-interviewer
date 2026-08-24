import { JwtUserPayload, UserRole } from './auth.types';

declare global {
  namespace Express {
    interface Request {
      user?: JwtUserPayload;
      userRole?: UserRole;
    }
  }
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: JwtUserPayload;
    userRole?: UserRole;
  }
}

export {};
