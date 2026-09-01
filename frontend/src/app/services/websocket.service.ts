import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject, Observable } from 'rxjs';
import SockJS from 'sockjs-client';
import { API_BASE } from '../api.config';

export interface StreamMessage {
  id: string;
  fields: Record<string, string>;
  timestamp?: string;
}

export interface DLQEvent {
  eventType: string;
  messageId?: string;
  payload?: Record<string, string>;
  streamName?: string;
  consumer?: string;
  details?: string;
  timestamp?: string;
  /** How the last attempt failed (backend `DLQEvent.FailureKind`); absent when nothing failed. */
  failureKind?: FailureKind;
}

/** Mirrors the backend `DLQEvent.FailureKind` enum. */
export type FailureKind = 'TIMEOUT' | 'EXPLICIT_FAIL' | 'POISON' | 'RELEASED';

/**
 * Pub/Sub events travel on the same socket as {@link DLQEvent} (backend `PubSubEvent`).
 * They carry a `channel` instead of a stream, and the pattern-routing demo adds `_pattern` /
 * `_subscriber` keys inside the payload.
 */
export interface PubSubEvent {
  eventType: string;
  channel?: string;
  payload?: Record<string, string>;
  details?: string;
  timestamp?: string;
}

/**
 * Per-Key Serialized slot events (backend `PerKeySlotEvent`). One state change of one worker:
 * `atMs` is epoch millis because the grid does arithmetic on it (slot binning, interval overlap),
 * which a formatted local time could not support.
 */
export interface PerKeySlotEvent {
  eventType: string;
  phase: 'STARTED' | 'FINISHED' | 'LOCK_SKIPPED';
  workerId: number;
  orderId: string;
  action: string;
  messageId: string;
  atMs: number;
}

/** Anything the backend can push down the socket. */
export type StreamEvent = DLQEvent | PubSubEvent | PerKeySlotEvent;

/**
 * WebSocket service for real-time communication with Spring Boot backend.
 * Uses SockJS for WebSocket connection with fallback support.
 */
@Injectable({
  providedIn: 'root'
})
export class WebSocketService {
  // SockJS does not implement the WebSocket interface fully, so use its own instance type.
  private socket: InstanceType<typeof SockJS> | null = null;
  private eventSubject = new Subject<StreamEvent>();
  /**
   * `BehaviorSubject`, not `Subject`: this service is a root singleton, so its socket outlives a
   * route change. A plain Subject emits only on a *transition*, so any component created after the
   * socket opened — i.e. anything reached by SPA navigation rather than a page load — subscribed to a
   * source that would never speak again and rendered "Disconnected" for good. `per-key-lanes` showed
   * exactly that on its three column badges. Late subscribers must be told the current state.
   */
  private connectionStatus = new BehaviorSubject<boolean>(false);
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 1000; // keep retrying; a demo left open shouldn't silently go dead
  private reconnectDelay = 3000;
  private isConnecting = false;
  private connected = false; // Track connection state manually

  /**
   * Connect to the WebSocket endpoint
   * @param endpoint WebSocket endpoint path (default: '/ws/dlq-events')
   */
  connect(endpoint = '/ws/dlq-events'): void {
    if (this.connected && this.socket) {
      console.log('WebSocket already connected');
      // Emit current connection status for new subscribers
      this.connectionStatus.next(true);
      return;
    }

    if (this.isConnecting) {
      console.log('WebSocket connection in progress');
      return;
    }

    this.isConnecting = true;
    // Spring Boot context path is /api, so WebSocket endpoint is /api/ws/dlq-events
    const url = `${API_BASE}${endpoint}`;

    try {
      // Use SockJS for better compatibility
      this.socket = new SockJS(url);

      this.socket.onopen = () => {
        console.log('WebSocket connection established');
        this.isConnecting = false;
        this.connected = true;
        this.reconnectAttempts = 0;
        this.connectionStatus.next(true);
      };

      this.socket.onmessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          this.eventSubject.next(data);
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error);
        }
      };

      this.socket.onerror = (error: Event) => {
        console.error('WebSocket error:', error);
        this.isConnecting = false;
        this.connected = false;
        this.connectionStatus.next(false);
      };

      this.socket.onclose = () => {
        console.log('WebSocket connection closed');
        this.isConnecting = false;
        this.connected = false;
        this.connectionStatus.next(false);
        this.attemptReconnect(endpoint);
      };
    } catch (error) {
      console.error('Failed to create WebSocket connection:', error);
      this.isConnecting = false;
      this.connected = false;
      this.connectionStatus.next(false);
    }
  }

  /**
   * Attempt to reconnect to the WebSocket
   */
  private attemptReconnect(endpoint: string): void {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
      
      setTimeout(() => {
        this.connect(endpoint);
      }, this.reconnectDelay);
    } else {
      console.error('Max reconnection attempts reached');
    }
  }

  /**
   * Disconnect from the WebSocket
   */
  disconnect(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  /**
   * Get observable for WebSocket events
   */
  getEvents(): Observable<StreamEvent> {
    return this.eventSubject.asObservable();
  }

  /**
   * Get observable for connection status
   */
  getConnectionStatus(): Observable<boolean> {
    return this.connectionStatus.asObservable();
  }

  /**
   * Check if WebSocket is currently connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Send a JSON payload to the server (e.g. an LLM-chat {type:'subscribe',cid} frame).
   * No-op if the socket isn't connected.
   */
  send(payload: unknown): void {
    if (this.socket && this.connected) {
      try {
        this.socket.send(JSON.stringify(payload));
      } catch (error) {
        console.error('Failed to send WebSocket message:', error);
      }
    }
  }
}

