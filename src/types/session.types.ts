export enum SessionStatus {
  SCHEDULED = 'SCHEDULED',
  ACTIVE = 'ACTIVE',
  COMPLETED = 'COMPLETED',
}

export interface InterviewSessionData {
  id: string;
  candidateId: string;
  recruiterId?: string | null;
  jobTitle: string;
  jobDescription?: string | null;
  resumeText?: string | null;
  status: SessionStatus;
  codeState: string;
  currentQuestionIndex: number;
  createdAt: Date;
  updatedAt: Date;
  candidate?: {
    id: string;
    fullName: string;
    email: string;
  };
  recruiter?: {
    id: string;
    fullName: string;
    email: string;
  } | null;
}

export interface CreateSessionDTO {
  candidateId?: string | null;
  recruiterId?: string | null;
  jobTitle: string;
  jobDescription?: string | null;
  resumeText?: string | null;
  initialCode?: string | null;
  status?: SessionStatus;
}

export interface UpdateSessionStatusDTO {
  status: SessionStatus;
}

// Socket.IO Payload Interfaces
export interface RoomJoinPayload {
  sessionId: string;
}

export interface CodeChangePayload {
  sessionId: string;
  code: string;
  cursorPosition?: {
    lineNumber: number;
    column: number;
  };
}

export interface ChatMessagePayload {
  sessionId: string;
  message: string;
  senderRole?: string;
  timestamp?: string;
}

export interface RecruiterIntervenePayload {
  sessionId: string;
  interventionType: 'question' | 'hint' | 'pause' | 'override' | string;
  content: string;
}
