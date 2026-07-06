// ============================================================================
// CONVERSATION & MESSAGE TYPES
// ============================================================================

export interface Conversation {
  id: string;
  userId: string;
  title?: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt?: Date;
  metadata?: Record<string, any>;
}

export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  sourceType?: "user" | "research" | "document" | "generated";
  metadata?: Record<string, any>;
  createdAt: Date;
}

// ============================================================================
// DOCUMENT TYPES
// ============================================================================

export type DocumentFormat = "pdf" | "docx" | "xlsx" | "pptx" | "csv";
export type DocumentStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "archived";

export interface Document {
  id: string;
  conversationId: string;
  userId: string;
  filename: string;
  fileType: DocumentFormat;
  fileSizeBytes: number;
  status: DocumentStatus;
  errorMessage?: string;
  totalPages?: number;
  totalChunks?: number;
  wordCount?: number;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
  archivedAt?: Date;
}

export interface DocumentChunk {
  id: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  pageNumber?: number;
  sectionTitle?: string;
  hierarchy?: string[];
  embedding?: number[];
  startOffset: number;
  endOffset: number;
  createdAt: Date;
}

// ============================================================================
// MEMORY TYPES (4-LAYER SYSTEM)
// ============================================================================

export interface MessageHistory {
  messages: Message[];
  totalCount: number;
}

export interface Observation {
  id: string;
  conversationId: string;
  summary: string;
  keyFacts: Record<string, any>;
  embedding?: number[];
  createdAt: Date;
}

export interface WorkingMemory {
  conversationGoal?: string;
  userPreferences?: Record<string, any>;
  currentTask?: string;
  context?: Record<string, any>;
}

export interface SemanticContext {
  id: string;
  summary: string;
  similarity: number;
}

export interface ContextPackage {
  recentMessages: Message[];
  observations: Observation[];
  workingMemory: WorkingMemory;
  semanticContext: SemanticContext[];
  assembledAt: Date;
}

// ============================================================================
// AGENT TYPES
// ============================================================================

export type AgentName = "supervisor" | "research" | "document" | "writer";

export interface AgentInput {
  conversationId: string;
  userId: string;
  query: string;
  context?: ContextPackage;
  previousResults?: any[];
}

export interface AgentOutput {
  agentName: AgentName;
  result: string;
  status: "success" | "failure" | "partial";
  error?: string;
  metadata?: Record<string, any>;
}

export interface AgentResult {
  agent: AgentName;
  output: string;
  status: "success" | "failure" | "partial";
  error?: string;
  executionTimeMs: number;
  tokenUsage?: TokenUsage;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// ============================================================================
// TOOL TYPES
// ============================================================================

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
  execute: (params: any) => Promise<any>;
}

export interface ToolResult {
  toolName: string;
  success: boolean;
  result?: any;
  error?: string;
  executionTimeMs: number;
}

// ============================================================================
// RAG TYPES
// ============================================================================

export interface ChunkingConfig {
  method: "naive" | "hierarchical";
  maxChunkSize: number; // tokens
  overlapSize: number; // tokens
  preserveStructure: boolean;
}

export interface EmbeddingConfig {
  model: string;
  dimensions: number;
  batchSize: number;
}

export interface RetrievalResult {
  chunks: DocumentChunk[];
  relevanceScores: number[];
  retrievalTimeMs: number;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  relevance: number;
  source: string;
  publishedDate?: string;
}

// ============================================================================
// API REQUEST/RESPONSE TYPES
// ============================================================================

export interface CreateConversationRequest {
  userId: string;
  title?: string;
}

export interface CreateConversationResponse {
  id: string;
  userId: string;
  title?: string;
  createdAt: Date;
}

export interface SendMessageRequest {
  conversationId: string;
  message: string;
  documentIds?: string[];
}

export interface SendMessageResponse {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  response: string;
  sources?: SearchResult[];
  agentsInvolved: AgentName[];
  timestamp: Date;
}

export interface UploadDocumentRequest {
  file: Buffer;
  filename: string;
  conversationId: string;
}

export interface UploadDocumentResponse {
  documentId: string;
  filename: string;
  format: DocumentFormat;
  status: DocumentStatus;
  uploadedAt: Date;
}

export interface GetConversationResponse {
  id: string;
  userId: string;
  title?: string;
  messageCount: number;
  documentCount: number;
  lastMessageAt?: Date;
  createdAt: Date;
}

export interface GetMessagesResponse {
  conversationId: string;
  messages: Message[];
  totalCount: number;
  limit: number;
  offset: number;
}

// ============================================================================
// ERROR TYPES
// ============================================================================

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public code?: string
  ) {
    super(message);
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, public field?: string) {
    super(400, message, "VALIDATION_ERROR");
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    const message = id
      ? `${resource} with id ${id} not found`
      : `${resource} not found`;
    super(404, message, "NOT_FOUND");
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

export class DatabaseError extends AppError {
  constructor(message: string) {
    super(500, message, "DATABASE_ERROR");
    Object.setPrototypeOf(this, DatabaseError.prototype);
  }
}

export class AuthError extends AppError {
  constructor(message: string = "Unauthorized") {
    super(401, message, "UNAUTHORIZED");
    Object.setPrototypeOf(this, AuthError.prototype);
  }
}

// ============================================================================
// UTILITY TYPES
// ============================================================================

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  database: boolean;
  timestamp: Date;
  uptime: number;
}

export interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  timestamp: Date;
  context?: Record<string, any>;
}