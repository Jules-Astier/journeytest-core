import { ConvexDataLifecycleProvider } from "./convex.js";
import { HttpDataLifecycleProvider } from "./http.js";
import { ScriptDataLifecycleProvider } from "./script.js";
import type {
  DataLifecycleProvider,
  DataLifecycleProviderContext,
  DataLifecycleProviderResult,
} from "./types.js";

export class DataLifecycleProviderRouter implements DataLifecycleProvider {
  readonly name = "data-lifecycle-router";
  private readonly providers: Map<string, DataLifecycleProvider>;

  constructor(providers: DataLifecycleProvider[] = defaultDataLifecycleProviders()) {
    this.providers = new Map(providers.map((provider) => [provider.name, provider]));
  }

  async runOperation(
    context: DataLifecycleProviderContext,
  ): Promise<DataLifecycleProviderResult> {
    const provider = this.providers.get(context.environment.provider);
    if (!provider) {
      throw new Error(
        `No data lifecycle provider registered for "${context.environment.provider}".`,
      );
    }

    return provider.runOperation(context);
  }
}

export function createDefaultDataLifecycleProvider(): DataLifecycleProvider {
  return new DataLifecycleProviderRouter();
}

function defaultDataLifecycleProviders(): DataLifecycleProvider[] {
  return [
    new ConvexDataLifecycleProvider(),
    new ScriptDataLifecycleProvider(),
    new HttpDataLifecycleProvider(),
  ];
}
