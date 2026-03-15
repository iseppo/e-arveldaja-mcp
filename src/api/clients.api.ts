import type { HttpClient } from "../http-client.js";
import type { Client, ApiResponse } from "../types/api.js";
import { BaseResource, cache } from "./base-resource.js";

export class ClientsApi extends BaseResource<Client> {
  constructor(client: HttpClient) {
    super(client, "/clients", "clients_id");
  }

  async deactivate(id: number): Promise<ApiResponse> {
    cache.invalidate(this.basePath);
    return this.client.patch<ApiResponse>(`/clients/${id}/deactivate`, {});
  }

  async restore(id: number): Promise<ApiResponse> {
    cache.invalidate(this.basePath);
    return this.client.patch<ApiResponse>(`/clients/${id}/reactivate`, {});
  }

  /** Not in OpenAPI spec — endpoint may not exist on all API versions */
  async merge(targetId: number, sourceId: number): Promise<ApiResponse> {
    cache.invalidate(this.basePath);
    return this.client.post<ApiResponse>(`/clients/${targetId}/merge/${sourceId}`, {});
  }

  async findByName(name: string): Promise<Client[]> {
    const all = await this.listAll();
    const lower = name.toLowerCase();
    return all.filter(c => !c.is_deleted && c.name.toLowerCase().includes(lower));
  }

  async findByCode(code: string): Promise<Client | undefined> {
    const all = await this.listAll();
    return all.find(c => c.code === code && !c.is_deleted);
  }

  async findByVatNo(vatNo: string): Promise<Client | undefined> {
    const normalized = vatNo.replace(/\s+/g, "").toUpperCase();
    const all = await this.listAll();
    return all.find(c =>
      !c.is_deleted &&
      c.invoice_vat_no?.replace(/\s+/g, "").toUpperCase() === normalized
    );
  }
}
