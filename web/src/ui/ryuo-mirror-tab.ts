import { html, type PropertyDeclarations } from "lit";
import {
  ASK_WHILE_STARTING,
  backgroundText,
  choiceText,
  displayDot,
  displayFailed,
  displayText,
  MIRROR_IN_STANDBY,
  mirrorSwitch,
  NOT_AVAILABLE,
  pointerText,
} from "../display.ts";
import type { AppState } from "../state.ts";
import { RyuoElement } from "./ryuo-element.ts";

const DOT_ICON = html`<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="2"/></svg>`;

/**
 * The Desktop mirror tab: the second-display switch with its status, error and retry, how to
 * place the virtual monitor, the mouse pointer's screen-share choice, and the requirements.
 * The host is the tab panel.
 */
export class RyuoMirrorTab extends RyuoElement {
  static override properties: PropertyDeclarations = { asking: { state: true } };
  /** Ask again's POST is running: the button stays disabled until it answers. */
  declare asking: boolean;

  constructor() {
    super();
    this.asking = false;
  }

  async #askAgain(): Promise<void> {
    if (!this.app) return;
    this.asking = true;
    this.flush();
    try {
      await this.app.actions.resetChoice();
    } finally {
      this.asking = false;
      this.flush();
    }
  }

  #switch() {
    const state = this.app?.store.state;
    const actions = this.app?.actions;
    const status = state?.display ?? null;
    const want = state?.displayWant ?? false;
    const { available, blocked } = mirrorSwitch(state);
    // "…" until the first poll; afterwards a null status means this ryuod has no second display.
    const text = status ? displayText(status) : state?.device ? NOT_AVAILABLE : "…";
    const failed = displayFailed(status);
    const error = failed ? (status?.error ?? "") : "";
    const pointer = pointerText(status);
    const background = backgroundText(status);
    return html`<button class="big-switch" id="displaySwitch" type="button" role="switch" aria-checked=${want ? "true" : "false"}
        aria-describedby="displayText" ?disabled=${!available || blocked} title=${blocked ? MIRROR_IN_STANDBY : ""}
        @click=${() => actions?.sendDisplay(!want)}>
        <span class="lbl"><b>Use the panel as a second display</b><span id="displayState"><span class=${displayDot(status)} id="displayDot"></span><span id="displayText" aria-live="polite">${text}</span></span></span>
        <span class="track" aria-hidden="true"></span>
      </button>
      <pre class="mono" id="displayErr" ?hidden=${!error}>${error}</pre>
      <p class="note" id="displayBackground" ?hidden=${!background}>${background}</p>
      <div><button class="btn" id="displayRetry" type="button" ?hidden=${!failed} @click=${() => actions?.sendDisplay(true)}>Try again now</button></div>
      ${this.#info(state)} ${this.#pointer(state, pointer)}`;
  }

  #info(state: AppState | undefined) {
    const open = !!state?.desktop?.displaySettings;
    return html`<div class="lines" id="displayInfo">
      <p>Adds Virtual-RYUO, a 2240×1080 virtual monitor, to the right of your main monitor. Windows dragged past its right edge appear on the panel.</p>
      <p>The stats overlay and background video are hidden while it runs. Brightness still works.</p>
      <p>The panel gets a new frame only when something on the virtual monitor changes. Turning it off removes the virtual monitor, which takes up to about 10 s.</p>
      <p id="displaySettingsHint">To move Virtual-RYUO, use Edit Arrangement in System Settings → Display &amp; Monitor → Display Configuration; its scale is set there too (Plasma may start it at 200 %). Searching "Display Configuration" in KRunner or the app launcher opens that page.</p>
      <div id="displaySettingsRow" ?hidden=${!open}><button class="btn" id="displaySettingsOpen" type="button"
        @click=${() => this.app?.actions.openDisplaySettings()}>Open Display Configuration</button></div>
    </div>`;
  }

  #pointer(state: AppState | undefined, pointer: string) {
    const desktop = state?.desktop ?? null;
    // ryuod refuses while the second display starts: the screen-share dialog may be open, and
    // its answer writes a new choice.
    const starting = state?.display?.state === "starting";
    return html`<div class="pointer-row">
      <div class="kv"><b>Mouse pointer</b><button class="btn" id="askAgain" type="button" ?hidden=${!desktop}
        ?disabled=${!desktop?.portalTokenSaved || starting || this.asking} title=${starting ? ASK_WHILE_STARTING : ""}
        @click=${() => this.#askAgain()}>Ask again</button></div>
      <p class="note" id="displayPointer" ?hidden=${!pointer}>${pointer}</p>
      <p class="note">To show the pointer, the desktop asks once which screen to share: choose Virtual-RYUO and allow restoring, so later starts skip the question.</p>
      <p class="note" id="choiceText" ?hidden=${!desktop}>${desktop ? choiceText(desktop) : ""}</p>
    </div>`;
  }

  protected override render() {
    return html`<div class="card main-col stack" style="gap: 16px" id="displaySection">${this.#switch()}</div>
      <div class="card side-col" style="gap: 10px">
        <h3>Requirements</h3>
        <div class="req">${DOT_ICON}<span>KDE Plasma on Wayland</span></div>
        <div class="req">${DOT_ICON}<span>krfb installed</span></div>
        <div class="req">${DOT_ICON}<span>NVIDIA GPU</span></div>
        <p class="note">ryuod does not check these yet; a missing one shows as an error when the display starts.</p>
      </div>`;
  }
}
