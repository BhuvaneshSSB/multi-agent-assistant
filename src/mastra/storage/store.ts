import { getDatabase } from "../../config/database";
import {
  Message,
  Conversation,
  Observation,
  DocumentFormat,
  DatabaseError,
} from "../../types/index";

export class Store {
  private db = getDatabase();

  // ============================================================================
  // DOCUMENT OPERATIONS
  // ============================================================================

  async saveDocument(
    conversationId: string,
    userId: string,
    filename: string,
    fileType: DocumentFormat,
    fileSizeBytes: number,
    metadata?: Record<string, any>
  ): Promise<string> {
    try {
      const result = await this.db.query(
        `INSERT INTO documents (conversation_id, user_id, filename, file_type, file_size_bytes, status, metadata, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, NOW(), NOW())
         RETURNING id`,
        [
          conversationId,
          userId,
          filename,
          fileType,
          fileSizeBytes,
          metadata ? JSON.stringify(metadata) : null,
        ]
      );

      return result.rows[0].id;
    } catch (error) {
      throw new DatabaseError(
        `Failed to save document: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async updateDocumentStatus(
    documentId: string,
    status: string,
    totalChunks?: number,
    errorMessage?: string
  ): Promise<void> {
    try {
      await this.db.query(
        `UPDATE documents
         SET status = $1, total_chunks = $2, error_message = $3, updated_at = NOW()
         WHERE id = $4`,
        [status, totalChunks || null, errorMessage || null, documentId]
      );
    } catch (error) {
      throw new DatabaseError(
        `Failed to update document status: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Ordered by created_at so callers get a stable, upload-order listing —
  // used both to know which documents exist for comparison retrieval and to
  // label retrieved chunks by filename instead of opaque documentId.
  async getDocumentsByConversation(
    conversationId: string
  ): Promise<Array<{ id: string; filename: string; status: string }>> {
    try {
      const result = await this.db.query(
        `SELECT id, filename, status
         FROM documents
         WHERE conversation_id = $1 AND status = 'completed'
         ORDER BY created_at ASC`,
        [conversationId]
      );
      return result.rows.map((row) => ({
        id: row.id,
        filename: row.filename,
        status: row.status,
      }));
    } catch (error) {
      throw new DatabaseError(
        `Failed to fetch documents for conversation: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // ============================================================================
  // UTILITY OPERATIONS
  // ============================================================================

  async testConnection(): Promise<boolean> {
    try {
      const result = await this.db.query("SELECT NOW()");
      return result.rows.length > 0;
    } catch (error) {
      console.error("Database test connection failed:", error);
      return false;
    }
  }
}

// Singleton instance
let storeInstance: Store | null = null;

export function getStore(): Store {
  if (!storeInstance) {
    storeInstance = new Store();
  }
  return storeInstance;
}