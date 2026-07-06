import { getDatabase } from "../../config/database";
import {
  Message,
  Conversation,
  Observation,
  DocumentChunk,
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

  // ============================================================================
  // DOCUMENT CHUNK OPERATIONS
  // ============================================================================

  async saveChunk(
    documentId: string,
    chunkIndex: number,
    content: string,
    embedding: number[],
    pageNumber?: number,
    sectionTitle?: string,
    hierarchy?: string[]
  ): Promise<string> {
    try {
      const result = await this.db.query(
        `INSERT INTO document_chunks (document_id, chunk_index, content, embedding, page_number, section_title, hierarchy, created_at)
         VALUES ($1, $2, $3, $4::vector, $5, $6, $7, NOW())
         RETURNING id`,
        [
          documentId,
          chunkIndex,
          content,
          `[${embedding.join(",")}]`,
          pageNumber || null,
          sectionTitle || null,
          hierarchy ? JSON.stringify(hierarchy) : null,
        ]
      );

      return result.rows[0].id;
    } catch (error) {
      throw new DatabaseError(
        `Failed to save chunk: ${error instanceof Error ? error.message : String(error)}`
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