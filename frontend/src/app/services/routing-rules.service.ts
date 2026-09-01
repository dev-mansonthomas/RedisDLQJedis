import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API_BASE } from '../api.config';

export interface RoutingRule {
  id: string;
  pattern: string;
  destination: string;
  description: string;
  priority: number;
  enabled: boolean;
  stopOnMatch: boolean;
}

export interface RoutingMetadata {
  exchangeStream: string;
  maxRules: number;
  version: string;
  updatedAt: string;
  description: string;
  ruleCount: number;
}

export interface RulesResponse {
  success: boolean;
  exchangeStream: string;
  rules: RoutingRule[];
  count: number;
}

export interface MetadataResponse {
  success: boolean;
  metadata: RoutingMetadata;
}

export interface RuleResponse {
  success: boolean;
  rule: RoutingRule;
  message?: string;
}

@Injectable({
  providedIn: 'root'
})
export class RoutingRulesService {
  private http = inject(HttpClient);
  private baseUrl = `${API_BASE}/routing-rules`;

  /**
   * Get all routing rules for an exchange stream.
   */
  getAllRules(exchangeStream: string): Observable<RulesResponse> {
    return this.http.get<RulesResponse>(`${this.baseUrl}/${exchangeStream}/rules`);
  }

  /**
   * Get a specific routing rule.
   */
  getRule(exchangeStream: string, ruleId: string): Observable<RuleResponse> {
    return this.http.get<RuleResponse>(`${this.baseUrl}/${exchangeStream}/rules/${ruleId}`);
  }

  /**
   * Create or update a routing rule.
   */
  saveRule(exchangeStream: string, rule: RoutingRule): Observable<RuleResponse> {
    return this.http.post<RuleResponse>(`${this.baseUrl}/${exchangeStream}/rules`, rule);
  }

  /**
   * Delete a routing rule.
   */
  deleteRule(exchangeStream: string, ruleId: string): Observable<{ success: boolean; message?: string }> {
    return this.http.delete<{ success: boolean; message?: string }>(
      `${this.baseUrl}/${exchangeStream}/rules/${ruleId}`
    );
  }

  /**
   * Get routing metadata for an exchange stream.
   */
  getMetadata(exchangeStream: string): Observable<MetadataResponse> {
    return this.http.get<MetadataResponse>(`${this.baseUrl}/${exchangeStream}/metadata`);
  }

  /**
   * Update routing metadata.
   */
  saveMetadata(exchangeStream: string, metadata: Partial<RoutingMetadata>): Observable<MetadataResponse> {
    return this.http.put<MetadataResponse>(`${this.baseUrl}/${exchangeStream}/metadata`, metadata);
  }

  /**
   * Reset all rules and metadata to defaults.
   */
  resetToDefaults(exchangeStream: string): Observable<RulesResponse & { metadata: RoutingMetadata }> {
    return this.http.post<RulesResponse & { metadata: RoutingMetadata }>(
      `${this.baseUrl}/${exchangeStream}/reset`,
      {}
    );
  }

  /**
   * Create an empty rule template.
   */
  createEmptyRule(): RoutingRule {
    return {
      id: '',
      pattern: '',
      destination: '',
      description: '',
      priority: 100,
      enabled: true,
      stopOnMatch: false
    };
  }
}

