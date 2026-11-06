import { httpKind } from "@moostjs/event-http";
import { current } from "@wooksjs/event-core";

/** The current event's HTTP response (wooks `HttpResponse`); throws outside an event. */
export const readHttpResponse = () => current().get(httpKind.keys.response);

/** A wooks `HttpResponse`. */
export type THttpResponse = NonNullable<ReturnType<typeof readHttpResponse>>;

/** Sets `Cache-Control` to `value` unless the response already has one (the app's own wins). */
export function defaultCacheControl(response: THttpResponse, value: string): void {
  if (response.getHeader("cache-control") === undefined) {
    response.setHeader("cache-control", value);
  }
}
