import type { HttpClient } from "../http-client.js";
import type { Journal, ApiResponse, ApiFile } from "../types/api.js";
import { BaseResource, cache } from "./base-resource.js";

export class JournalsApi extends BaseResource<Journal> {
  constructor(client: HttpClient) {
    super(client, "/journals", "journals_id");
  }

  async confirm(id: number): Promise<ApiResponse> {
    cache.invalidate(this.basePath);
    return this.client.patch<ApiResponse>(`/journals/${id}/register`, {});
  }

  async getDocument(id: number): Promise<ApiFile> {
    return this.client.get<ApiFile>(`/journals/${id}/document_user`);
  }

  async uploadDocument(id: number, name: string, contents: string): Promise<ApiResponse> {
    cache.invalidate(this.basePath);
    return this.client.request<ApiResponse>(`/journals/${id}/document_user`, {
      method: "PUT",
      body: { name, contents },
    });
  }

  async deleteDocument(id: number): Promise<ApiResponse> {
    cache.invalidate(this.basePath);
    return this.client.delete<ApiResponse>(`/journals/${id}/document_user`);
  }
}
