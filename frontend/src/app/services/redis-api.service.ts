import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface StreamEntry {
  id: string;
  fields: Record<string, string>;
  // Present on /pending-messages entries only (PEL info)
  deliveryCount?: number;
  consumer?: string;
  idleMs?: number;
}

export interface StreamStats {
  streamLength: number;
  dlqLength: number;
  pendingCount: number;
  success: boolean;
}

export interface MessagesResponse {
  success: boolean;
  streamName: string;
  messages: StreamEntry[];
  /** Size of the returned page — capped by the requested `count`, so it cannot reveal truncation. */
  count: number;
  /** The stream's own XLEN. Absent on older backends; callers must fall back to `count`. */
  streamLength?: number;
}

export interface NextMessageResponse {
  success: boolean;
  nextMessageId: string | null;
}

/**
 * Service for making HTTP requests to the Spring Boot Redis API
 */
@Injectable({
  providedIn: 'root'
})
export class RedisApiService {
  private http = inject(HttpClient);
  private baseUrl = 'http://localhost:8080/api/dlq';

  /**
   * Get stream statistics
   */
  getStats(streamName: string, dlqStreamName: string, groupName: string): Observable<StreamStats> {
    const params = new HttpParams()
      .set('streamName', streamName)
      .set('dlqStreamName', dlqStreamName)
      .set('groupName', groupName);

    return this.http.get<StreamStats>(`${this.baseUrl}/stats`, { params });
  }

  /**
   * Get messages from a stream
   */
  getMessages(streamName: string, count = 10): Observable<MessagesResponse> {
    const params = new HttpParams()
      .set('streamName', streamName)
      .set('count', count.toString());

    return this.http.get<MessagesResponse>(`${this.baseUrl}/messages`, { params });
  }

  /**
   * Get pending messages for a consumer group
   */
  getPendingMessages(streamName: string, groupName: string, count = 10): Observable<MessagesResponse> {
    const params = new HttpParams()
      .set('streamName', streamName)
      .set('groupName', groupName)
      .set('count', count.toString());

    return this.http.get<MessagesResponse>(`${this.baseUrl}/pending-messages`, { params });
  }

  /**
   * Initialize consumer group for a stream
   */
  initializeGroup(streamName: string, groupName: string): Observable<{success: boolean}> {
    const params = new HttpParams()
      .set('streamName', streamName)
      .set('groupName', groupName);

    return this.http.post<{success: boolean}>(`${this.baseUrl}/init-group`, null, { params });
  }

  /**
   * Get the next pending message ID (oldest pending message)
   */
  getNextMessage(streamName: string, groupName: string): Observable<NextMessageResponse> {
    const params = new HttpParams()
      .set('streamName', streamName)
      .set('groupName', groupName);

    return this.http.get<NextMessageResponse>(`${this.baseUrl}/next-message`, { params });
  }

  /**
   * Cleanup streams (for testing)
   */
  cleanup(streamName: string, dlqStreamName: string): Observable<{success: boolean}> {
    const params = new HttpParams()
      .set('streamName', streamName)
      .set('dlqStreamName', dlqStreamName);

    return this.http.post<{success: boolean}>(`${this.baseUrl}/cleanup`, null, { params });
  }
}

