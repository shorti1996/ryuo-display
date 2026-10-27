/** The page's entry: the stylesheets, the elements, the store, and the poll that feeds it. */
import "./fonts.css";
import "./styles.css";
import { createActions } from "./actions.ts";
import { createPoll, Store } from "./state.ts";
import { RyuoApp } from "./ui/ryuo-app.ts";
import { RyuoAppTab } from "./ui/ryuo-app-tab.ts";

// Defined once per document. The tests start the page again in the same document after
// vi.resetModules(); the first start's classes stay, and the new store reaches them through `app`.
for (const [name, element] of [
  ["ryuo-app", RyuoApp],
  ["ryuo-app-tab", RyuoAppTab],
] as const) {
  if (!customElements.get(name)) customElements.define(name, element);
}

const store = new Store();
const poll = createPoll(store);
const shell = document.querySelector<RyuoApp>("ryuo-app");
if (shell) shell.app = { store, actions: createActions(store, poll) };
void poll.start();
