import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API_BASE } from '../api.config';

export interface ChatTurn {
  streamId: string;
  role: string;
  content: string;
  ts?: number;
  msgId?: string;
  model?: string;
}

export interface GroupInfo {
  name: string;
  consumers: number;
  pending: number;
  lag?: number;
  lastDeliveredId?: string;
  pendingState?: string; // 'processing' (normal wait) | 'failing' (stuck / awaiting recovery)
}

export interface Flag {
  streamId: string;
  msgId: string;
  term: string;
  reason: string;
  ts?: number;
}

export interface DlqEntry {
  streamId: string;
  msgId: string;
  content: string;
  reason: string;
}

export interface GroupsInfo {
  stream: string;
  length: number;
  tokenStream: string;
  tokenStreamLength: number;
  groups: GroupInfo[];
  flags: Flag[];
  stats: Record<string, string>;
  dlqStream: string;
  dlq: DlqEntry[];
}

export interface MessagePosted {
  cid: string;
  msgId: string;
  streamId: string;
}

export interface SeriesPoint {
  ts: number;
  value: number;
}

/**
 * HTTP client for the LLM Chat pattern (#12) backend (`/api/llm-chat`).
 */
@Injectable({
  providedIn: 'root'
})
export class LlmChatService {
  private http = inject(HttpClient);
  private baseUrl = `${API_BASE}/llm-chat`;

  postMessage(cid: string, content: string): Observable<MessagePosted> {
    return this.http.post<MessagePosted>(`${this.baseUrl}/${cid}/message`, { content });
  }

  history(cid: string): Observable<ChatTurn[]> {
    return this.http.get<ChatTurn[]>(`${this.baseUrl}/${cid}/history`);
  }

  groups(cid: string): Observable<GroupsInfo> {
    return this.http.get<GroupsInfo>(`${this.baseUrl}/${cid}/groups`);
  }

  reset(cid: string): Observable<void> {
    return this.http.post<void>(`${this.baseUrl}/${cid}/reset`, {});
  }

  killWorker(cid: string): Observable<void> {
    return this.http.post<void>(`${this.baseUrl}/${cid}/kill-worker`, {});
  }

  tokenSeries(cid: string): Observable<SeriesPoint[]> {
    return this.http.get<SeriesPoint[]>(`${this.baseUrl}/${cid}/token-series`);
  }
}
