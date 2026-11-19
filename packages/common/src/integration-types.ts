export type IntegrationScope = "user" | "local" | "project";
export type IntegrationTransport = "stdio" | "http" | "sse" | "unknown";
export interface IntegrationEntry {
  name: string;
  scope: IntegrationScope;
  transport: IntegrationTransport;
  enabled: "unknown";
}
export interface IntegrationSource {
  scope: "user-local" | "project";
  status: "read" | "missing" | "unreadable";
}
export interface IntegrationCatalogRequest {
  type: "integration_catalog_request";
  sessionId: string;
  requestId: string;
}
export interface IntegrationCatalogResponse {
  type: "integration_catalog";
  sessionId: string;
  requestId: string;
  entries: IntegrationEntry[];
  sources: IntegrationSource[];
  truncated: boolean;
  error?: string;
}
