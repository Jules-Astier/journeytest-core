import {
  PiBookmarkCurator,
  type BookmarkCurator,
  type PiBookmarkCuratorOptions,
} from "../curation/index.js";
import { PiSdkDirector, type AgentDirector, type PiSdkDirectorOptions } from "../directors/index.js";
import { AgentBrowserDriver } from "../drivers/agent-browser/index.js";
import type { BrowserDriver } from "../drivers/index.js";
import {
  ConvexDataLifecycleProvider,
  DataLifecycleProviderRouter,
  HttpDataLifecycleProvider,
  ScriptDataLifecycleProvider,
  type DataLifecycleProvider,
} from "../lifecycle/index.js";

export type ApiKeyLoader = (
  provider: string,
) => Promise<string | undefined> | string | undefined;

export interface AgentDirectorFactoryContext {
  provider: string;
  modelId: string;
  getApiKey?: ApiKeyLoader;
}

export interface BrowserDriverFactoryContext {}

export interface BookmarkCuratorFactoryContext {
  provider: string;
  modelId: string;
  getApiKey?: ApiKeyLoader;
  systemPrompt?: string;
}

export interface DataLifecycleProviderFactoryContext {}

export type ComponentFactory<TContext, TInstance> = (context: TContext) => TInstance;

export interface ComponentFactoryRegistration<TContext, TInstance> {
  create: ComponentFactory<TContext, TInstance>;
  authProvider?: (context: TContext) => string | undefined;
}

export class ComponentFactoryRegistry<TContext, TInstance> {
  private readonly registrations = new Map<string, ComponentFactoryRegistration<TContext, TInstance>>();

  constructor(private readonly label: string) {}

  register(
    name: string,
    registration:
      | ComponentFactory<TContext, TInstance>
      | ComponentFactoryRegistration<TContext, TInstance>,
  ): this {
    assertFactoryName(name);
    if (this.registrations.has(name)) {
      throw new Error(`${this.label} factory "${name}" is already registered.`);
    }

    this.registrations.set(name, normalizeRegistration(registration));
    return this;
  }

  replace(
    name: string,
    registration:
      | ComponentFactory<TContext, TInstance>
      | ComponentFactoryRegistration<TContext, TInstance>,
  ): this {
    assertFactoryName(name);
    this.registrations.set(name, normalizeRegistration(registration));
    return this;
  }

  has(name: string): boolean {
    return this.registrations.has(name);
  }

  names(): string[] {
    return [...this.registrations.keys()].sort();
  }

  assertRegistered(name: string): void {
    this.get(name);
  }

  authProvider(name: string, context: TContext): string | undefined {
    return this.get(name).authProvider?.(context);
  }

  create(name: string, context: TContext): TInstance {
    return this.get(name).create(context);
  }

  private get(name: string): ComponentFactoryRegistration<TContext, TInstance> {
    const registration = this.registrations.get(name);
    if (!registration) {
      const available = this.names().join(", ") || "none";
      throw new Error(`Unknown ${this.label} factory "${name}". Available: ${available}.`);
    }
    return registration;
  }
}

export interface JourneyTestFactoryRegistry {
  directors: ComponentFactoryRegistry<AgentDirectorFactoryContext, AgentDirector>;
  browserDrivers: ComponentFactoryRegistry<BrowserDriverFactoryContext, BrowserDriver>;
  bookmarkCurators: ComponentFactoryRegistry<
    BookmarkCuratorFactoryContext,
    BookmarkCurator | undefined
  >;
  dataLifecycleProviders: ComponentFactoryRegistry<
    DataLifecycleProviderFactoryContext,
    DataLifecycleProvider
  >;
}

export function createJourneyTestFactoryRegistry(): JourneyTestFactoryRegistry {
  return {
    directors: new ComponentFactoryRegistry("agent director"),
    browserDrivers: new ComponentFactoryRegistry("browser driver"),
    bookmarkCurators: new ComponentFactoryRegistry("bookmark curator"),
    dataLifecycleProviders: new ComponentFactoryRegistry("data lifecycle provider"),
  };
}

export function createDefaultJourneyTestFactoryRegistry(): JourneyTestFactoryRegistry {
  return registerDefaultJourneyTestFactories(createJourneyTestFactoryRegistry());
}

export function registerDefaultJourneyTestFactories(
  registry: JourneyTestFactoryRegistry,
): JourneyTestFactoryRegistry {
  registry.directors.register("pi", {
    create: (context) =>
      new PiSdkDirector({
        provider: context.provider as PiSdkDirectorOptions["provider"],
        modelId: context.modelId,
        getApiKey: context.getApiKey,
      }),
    authProvider: (context) => context.provider,
  });

  registry.browserDrivers.register("agent-browser", () => new AgentBrowserDriver());

  registry.bookmarkCurators.register("pi", {
    create: (context) =>
      new PiBookmarkCurator({
        provider: context.provider as PiBookmarkCuratorOptions["provider"],
        modelId: context.modelId,
        getApiKey: context.getApiKey,
        systemPrompt: context.systemPrompt,
      }),
    authProvider: (context) => context.provider,
  });
  registry.bookmarkCurators.register("none", () => undefined);

  registry.dataLifecycleProviders.register("default", () => new DataLifecycleProviderRouter());
  registry.dataLifecycleProviders.register("convex", () => new ConvexDataLifecycleProvider());
  registry.dataLifecycleProviders.register("script", () => new ScriptDataLifecycleProvider());
  registry.dataLifecycleProviders.register("http", () => new HttpDataLifecycleProvider());

  return registry;
}

function normalizeRegistration<TContext, TInstance>(
  registration:
    | ComponentFactory<TContext, TInstance>
    | ComponentFactoryRegistration<TContext, TInstance>,
): ComponentFactoryRegistration<TContext, TInstance> {
  if (typeof registration === "function") {
    return { create: registration };
  }
  return registration;
}

function assertFactoryName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    throw new Error(`Factory names must be non-empty ids. Received "${name}".`);
  }
}
