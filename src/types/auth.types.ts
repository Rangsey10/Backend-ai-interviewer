export enum UserRole {
  CANDIDATE = 'CANDIDATE',
  RECRUITER = 'RECRUITER',
  ADMIN = 'ADMIN',
}

export type RoleType = keyof typeof UserRole | 'candidate' | 'recruiter' | 'admin';

export interface JwtUserPayload {
  userId: string;
  email: string;
  role: UserRole;
  iat?: number;
  exp?: number;
}

export interface SanitizedUser {
  id: string;
  fullName: string;
  email: string;
  role: UserRole;
  status?: 'PENDING_APPROVAL' | 'ACTIVE' | 'REJECTED' | 'SUSPENDED';
  resumeUrl?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthResponse {
  user: SanitizedUser;
  /** null while a recruiter account awaits admin approval */
  token: string | null;
  pendingApproval?: boolean;
}
