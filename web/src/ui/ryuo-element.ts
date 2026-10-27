import { LitElement, type PropertyDeclarations, type ReactiveController } from "lit";
import type { App } from "../actions.ts";
import type { Store } from "../state.ts";

/**
 * The base of the page's elements. Light DOM: the element renders into itself, so the one
 * global stylesheet applies and every id stays reachable from `document`.
 *
 * `app` is a property, not a module import: custom element names stay defined for the life of
 * the document, so a page started twice in one document (each test re-imports main.ts) reuses
 * the first start's classes, and only a property reaches the second start's store.
 */
export class RyuoElement extends LitElement {
  static override properties: PropertyDeclarations = { app: { attribute: false } };
  declare app: App | undefined;

  constructor() {
    super();
    new StoreController(this);
  }

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  /**
   * Render a pending update now rather than at the next microtask. The old page wrote the DOM
   * inside the event handler, and its tests read the result right after a click or key press.
   */
  flush(): void {
    if (this.hasUpdated && this.isUpdatePending) this.performUpdate();
  }
}

/** Re-renders its host, at once, after every change to the store of the host's `app`. */
export class StoreController implements ReactiveController {
  #host: RyuoElement;
  #store: Store | undefined;
  #off: (() => void) | undefined;

  constructor(host: RyuoElement) {
    this.#host = host;
    host.addController(this);
  }

  hostConnected(): void {
    this.#follow();
  }

  // `app` can arrive after the element is connected; each update checks for a new store.
  hostUpdate(): void {
    this.#follow();
  }

  hostDisconnected(): void {
    this.#off?.();
    this.#off = this.#store = undefined;
  }

  #follow(): void {
    const store = this.#host.app?.store;
    if (store === this.#store) return;
    this.#off?.();
    this.#store = store;
    this.#off = store?.subscribe(() => {
      this.#host.requestUpdate();
      this.#host.flush();
    });
  }
}
