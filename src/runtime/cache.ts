import { hash } from "ohash";
import {
  handleCacheHeaders,
  defineEventHandler,
  createEvent,
  EventHandler,
} from "h3";
import type { H3Event } from "h3";
import { parseURL } from "ufo";
import { useStorage } from "#internal/nitro";

export interface CacheEntry<T = any> {
  value?: T;
  expires?: number;
  mtime?: number;
  integrity?: string;
}

export interface CacheOptions<T = any> {
  name?: string;
  getKey?: (...args: any[]) => string;
  transform?: (entry: CacheEntry<T>, ...args: any[]) => any;
  validate?: (entry: CacheEntry<T>) => boolean;
  group?: string;
  integrity?: any;
  maxAge?: number;
  static?: boolean; // TODO
  swr?: boolean;
  staleMaxAge?: number;
  base?: string;
}

const defaultCacheOptions = {
  name: "_",
  base: "/cache",
  swr: true,
  maxAge: 1,
};

export function defineCachedFunction<T = any>(
  fn: (...args) => T | Promise<T>,
  opts: CacheOptions<T>
) {
  opts = { ...defaultCacheOptions, ...opts };

  const pending: { [key: string]: Promise<T> } = {};

  // Normalize cache params
  const group = opts.group || "nitro";
  const name = opts.name || fn.name || "_";
  const integrity = hash([opts.integrity, fn, opts]);
  const validate = opts.validate || (() => true);

  async function get(
    key: string,
    resolver: () => T | Promise<T>
  ): Promise<CacheEntry<T>> {
    // Use extension for key to avoid conflicting with parent namespace (foo/bar and foo/bar/baz)
    const cacheKey = [opts.base, group, name, key + ".json"]
      .filter(Boolean)
      .join(":")
      .replace(/:\/$/, ":index");
    const entry: CacheEntry<T> =
      ((await useStorage().getItem(cacheKey)) as any) || {};

    const ttl = (opts.maxAge ?? opts.maxAge ?? 0) * 1000;
    if (ttl) {
      entry.expires = Date.now() + ttl;
    }

    const expired =
      entry.integrity !== integrity ||
      (ttl && Date.now() - (entry.mtime || 0) > ttl) ||
      !validate(entry);

    const _resolve = async () => {
      if (!pending[key]) {
        // Remove cached entry to prevent using expired cache on concurrent requests
        entry.value = undefined;
        entry.integrity = undefined;
        entry.mtime = undefined;
        entry.expires = undefined;
        pending[key] = Promise.resolve(resolver());
      }
      entry.value = await pending[key];
      entry.mtime = Date.now();
      entry.integrity = integrity;
      delete pending[key];
      if (validate(entry)) {
        useStorage()
          .setItem(cacheKey, entry)
          .catch((error) => console.error("[nitro] [cache]", error));
      }
    };

    const _resolvePromise = expired ? _resolve() : Promise.resolve();

    if (opts.swr && entry.value) {
      // eslint-disable-next-line no-console
      _resolvePromise.catch(console.error);
      // eslint-disable-next-line unicorn/no-useless-promise-resolve-reject
      return entry;
    }

    return _resolvePromise.then(() => entry);
  }

  return async (...args) => {
    const key = (opts.getKey || getKey)(...args);
    const entry = await get(key, () => fn(...args));
    let value = entry.value;
    if (opts.transform) {
      value = (await opts.transform(entry, ...args)) || value;
    }
    return value;
  };
}

export const cachedFunction = defineCachedFunction;

function getKey(...args: string[]) {
  return args.length > 0 ? hash(args, {}) : "";
}

export interface ResponseCacheEntry<T = any> {
  body: T;
  code: number;
  headers: Record<string, string | number | string[]>;
}

export interface CachedEventHandlerOptions<T = any>
  extends Omit<CacheOptions<ResponseCacheEntry<T>>, "transform" | "validate"> {
  getKey?: (event: H3Event) => string;
  headersOnly?: boolean;
}

function escapeKey(key: string) {
  return key.replace(/[^\dA-Za-z]/g, "");
}

export function defineCachedEventHandler<T = any>(
  handler: EventHandler<T>,
  opts: CachedEventHandlerOptions<T> = defaultCacheOptions
): EventHandler<T> {
  const _opts: CacheOptions<ResponseCacheEntry<T>> = {
    ...opts,
    getKey: (event) => {
      const key = opts.getKey?.(event);
      if (key) {
        return escapeKey(key);
      }
      const url = event.node.req.originalUrl || event.node.req.url;
      const friendlyName = escapeKey(decodeURI(parseURL(url).pathname)).slice(
        0,
        16
      );
      const urlHash = hash(url);
      return `${friendlyName}.${urlHash}`;
    },
    validate: (entry) => {
      if (entry.value.code >= 400) {
        return false;
      }
      if (entry.value.body === undefined) {
        return false;
      }
      return true;
    },
    group: opts.group || "nitro/handlers",
    integrity: [opts.integrity, handler],
  };

  const _cachedHandler = cachedFunction<ResponseCacheEntry<T>>(
    async (incomingEvent: H3Event) => {
      // Create proxies to avoid sharing state with user request
      const reqProxy = cloneWithProxy(incomingEvent.node.req, { headers: {} });
      const resHeaders: Record<string, number | string | string[]> = {};
      let _resSendBody;
      const resProxy = cloneWithProxy(incomingEvent.node.res, {
        statusCode: 200,
        getHeader(name) {
          return resHeaders[name];
        },
        setHeader(name, value) {
          resHeaders[name] = value as any;
          return this;
        },
        getHeaderNames() {
          return Object.keys(resHeaders);
        },
        hasHeader(name) {
          return name in resHeaders;
        },
        removeHeader(name) {
          delete resHeaders[name];
        },
        getHeaders() {
          return resHeaders;
        },
        end(chunk, arg2?, arg3?) {
          if (typeof chunk === "string") {
            _resSendBody = chunk;
          }
          if (typeof arg2 === "function") {
            arg2();
          }
          if (typeof arg3 === "function") {
            arg3();
          }
          return this;
        },
        write(chunk, arg2?, arg3?) {
          if (typeof chunk === "string") {
            _resSendBody = chunk;
          }
          if (typeof arg2 === "function") {
            arg2();
          }
          if (typeof arg3 === "function") {
            arg3();
          }
          return this;
        },
        writeHead(statusCode, headers) {
          this.statusCode = statusCode;
          if (headers) {
            for (const header in headers) {
              this.setHeader(header, headers[header]);
            }
          }
          return this;
        },
      });

      // Call handler
      const event = createEvent(reqProxy, resProxy);
      event.context = incomingEvent.context;
      const body = (await handler(event)) || _resSendBody;

      // Collect cachable headers
      const headers = event.node.res.getHeaders();
      headers.etag = headers.Etag || headers.etag || `W/"${hash(body)}"`;
      headers["last-modified"] =
        headers["Last-Modified"] ||
        headers["last-modified"] ||
        new Date().toUTCString();
      const cacheControl = [];
      if (opts.swr) {
        if (opts.maxAge) {
          cacheControl.push(`s-maxage=${opts.maxAge}`);
        }
        if (opts.staleMaxAge) {
          cacheControl.push(`stale-while-revalidate=${opts.staleMaxAge}`);
        } else {
          cacheControl.push("stale-while-revalidate");
        }
      } else if (opts.maxAge) {
        cacheControl.push(`max-age=${opts.maxAge}`);
      }
      if (cacheControl.length > 0) {
        headers["cache-control"] = cacheControl.join(", ");
      }

      // Create cache entry for response
      const cacheEntry: ResponseCacheEntry<T> = {
        code: event.node.res.statusCode,
        headers,
        body,
      };

      return cacheEntry;
    },
    _opts
  );

  return defineEventHandler<T>(async (event) => {
    // Headers-only mode
    if (opts.headersOnly) {
      // TODO: Send SWR too
      if (handleCacheHeaders(event, { maxAge: opts.maxAge })) {
        return;
      }
      return handler(event);
    }

    // Call with cache
    const response = await _cachedHandler(event);

    // Don't continue if response is already handled by user
    if (event.node.res.headersSent || event.node.res.writableEnded) {
      return response.body;
    }

    // Check for cache headers
    if (
      handleCacheHeaders(event, {
        modifiedTime: new Date(response.headers["last-modified"] as string),
        etag: response.headers.etag as string,
        maxAge: opts.maxAge,
      })
    ) {
      return;
    }

    // Send status and headers
    event.node.res.statusCode = response.code;
    for (const name in response.headers) {
      event.node.res.setHeader(name, response.headers[name]);
    }

    // Send body
    return response.body;
  });
}

function cloneWithProxy<T extends object = any>(
  obj: T,
  overrides: Partial<T>
): T {
  return new Proxy(obj, {
    get(target, property, receiver) {
      if (property in overrides) {
        return overrides[property];
      }
      return Reflect.get(target, property, receiver);
    },
    set(target, property, value, receiver) {
      if (property in overrides) {
        overrides[property] = value;
        return true;
      }
      return Reflect.set(target, property, value, receiver);
    },
  });
}

export const cachedEventHandler = defineCachedEventHandler;
