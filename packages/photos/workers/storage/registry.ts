import type { StorageConnectionId } from "../../shared/ids";
import { getConnectionRow, type ConnectionRow } from "../db/storage-connections";
import type { PhotosEnv } from "../env";
import { found } from "../http";
import { decryptSecret } from "./credentials";
import type { StorageProvider } from "./provider";
import { R2BindingProvider, type R2BindingConfig } from "./r2-binding";
import { R2S3Provider, type R2S3Config, type R2S3Secret } from "./r2-s3";

/**
 * Builds providers for connections. The only place secrets are decrypted, and they never leave the
 * provider they configure. One registry serves one request, caching providers by connection.
 */
export class StorageRegistry {
  private readonly providers = new Map<string, Promise<StorageProvider>>();

  constructor(private readonly env: PhotosEnv, private readonly origin: string) {}

  /** The provider for a connection id, or a 404 when there is no such connection. */
  get(connectionId: StorageConnectionId | string): Promise<StorageProvider> {
    let provider = this.providers.get(connectionId);
    if (!provider) {
      provider = (async () => this.forRow(found(await getConnectionRow(this.env.PHOTOS_DB, connectionId), "connection_not_found")))();
      provider.catch(() => this.providers.delete(connectionId));
      this.providers.set(connectionId, provider);
    }
    return provider;
  }

  /** The provider for a row already read. */
  async forRow(row: ConnectionRow): Promise<StorageProvider> {
    const config: unknown = JSON.parse(row.config_json);
    switch (row.kind) {
      case "r2-binding":
        return new R2BindingProvider(this.env, row.id, config as R2BindingConfig, this.origin);
      case "r2-s3": {
        if (!row.secret_ciphertext) throw new Error(`connection ${row.id} has no credentials`);
        const secret = await decryptSecret<R2S3Secret>(this.env, row.id, row.secret_ciphertext);
        return new R2S3Provider(config as R2S3Config, secret);
      }
      case "nas":
        throw new Error("NAS connections arrive in phase 3");
    }
  }
}
