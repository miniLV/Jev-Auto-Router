import { inferTier, type ModelCatalog, type ModelInfo } from "./catalog.js";

export type { ModelCatalog };
import { digest } from "./canonical.js";

/** The trusted host surface's model listing (e.g. Codex App Server model/list). */
export interface HostModelList {
  source: string;
  models: Array<{ model: string; supported_efforts?: string[]; tier?: ModelInfo["tier"] }>;
}

/**
 * Discovery reads a trusted host surface only. A model name seen in a file or
 * config without a requestable surface is DISCOVERED-only and produces no
 * pairs. UNKNOWN availability means absent.
 */
export class ModelDiscovery {
  #cached?: { key: string; catalog: ModelCatalog };

  async discover(sessionId: string, fetchList: () => Promise<HostModelList>, now: number): Promise<ModelCatalog> {
    const list = await fetchList();
    const models: ModelInfo[] = [];
    for (const entry of list.models) {
      const tier = entry.tier ?? inferTier(entry.model);
      // The four-tier product routes only resolvable GPT-family tiers.
      if (!tier) continue;
      models.push({
        model: entry.model,
        tier,
        supported_efforts: entry.supported_efforts ?? ["medium"],
        requestable: true,
      });
    }
    const catalog: ModelCatalog = {
      source: list.source,
      models,
      session_binding_digest: digest({ session: sessionId, source: list.source, models: models.map(m => m.model) }),
      observed_at: now,
    };
    const key = `${sessionId}:${catalog.session_binding_digest}`;
    if (this.#cached?.key === key) return structuredClone(this.#cached.catalog);
    this.#cached = { key, catalog: structuredClone(catalog) };
    return catalog;
  }
}
