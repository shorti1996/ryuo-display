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
import { protectionStatus } from "../protection.ts";
import type { AppState } from "../state.ts";
import { RyuoElement } from "./ryuo-element.ts";

const DOT_ICON = html`<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="2"/></svg>`;

/**
 * The Desktop mirror tab: the second-display switch with its status, error and retry, how to
 * place the virtual monitor, the mouse pointer's screen-share choice, burn-in protection, and
 * the requirements. The host is the tab panel.
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
      <p>While it runs, HomeUI shows a plain black backdrop with no stats overlay; overlay changes are saved and applied when it stops. Brightness still works.</p>
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

  /** The switch: on goes out at once; off asks first, and Turn off takes the focus. */
  #toggleProtection(): void {
    if (this.app?.actions.toggleProtection()) this.querySelector<HTMLElement>("#protTurnOff")?.focus();
  }

  #cancelProtection(): void {
    this.app?.actions.cancelProtection();
    this.querySelector<HTMLElement>("#protSwitch")?.focus();
  }

  /** Burn-in protection: hidden for a ryuod without the setting (AppState.protection null). */
  #protection(state: AppState | undefined) {
    const protection = state?.protection ?? null;
    // Before the first poll the card is hidden; its parts start as the old page's markup did.
    const enabled = protection?.enabled ?? true;
    const sending = !!state?.editing.has("burnInProtection");
    return html`<div class="card stack" id="protCard" style="gap: 10px" ?hidden=${!protection}>
      <h3>Burn-in protection</h3>
      <button class="big-switch" id="protSwitch" type="button" role="switch" aria-checked=${enabled ? "true" : "false"}
        aria-describedby="protStatus" ?disabled=${sending} @click=${() => this.#toggleProtection()}>
        <span class="lbl"><b>Protect the OLED panel</b><span id="protStatus" aria-live="polite">${protection ? protectionStatus(protection) : ""}</span></span>
        <span class="track" aria-hidden="true"></span>
      </button>
      <p class="note" id="protWarn" ?hidden=${enabled}>Burn-in protection is off. Windows left on screen for hours can leave a permanent mark on the OLED panel.</p>
      <div id="protAsk" ?hidden=${!state?.protectionAsking}>
        <p>Turn off burn-in protection? Windows left on screen for hours can leave a permanent mark on the OLED panel.</p>
        <div class="row"><button class="btn primary" id="protTurnOff" type="button" @click=${() => this.app?.actions.sendProtection(false)}>Turn off</button><button
          class="btn" id="protCancel" type="button" @click=${() => this.#cancelProtection()}>Cancel</button></div>
      </div>
      <div class="lines">
        <p>Only while the panel shows the desktop. The picture shifts by up to 4 px every 3 min, and goes black for 2 s every 5 min.</p>
        <p>After 3 min without a change on the desktop the panel dims to 40 % of your brightness, at most 15 % of full; after 10 min it goes black.</p>
        <p>A window, video or pointer move wakes it at once; a blinking cursor or a clock does not. Your windows and the virtual monitor stay as they are.</p>
      </div>
    </div>`;
  }

  protected override render() {
    const state = this.app?.store.state;
    return html`<div class="card main-col stack" style="gap: 16px" id="displaySection">${this.#switch()}</div>
      <div class="side-col">
        ${this.#protection(state)}
        <div class="card stack" style="gap: 10px">
          <h3>Requirements</h3>
          <div class="req">${DOT_ICON}<span>KDE Plasma on Wayland</span></div>
          <div class="req">${DOT_ICON}<span>krfb installed</span></div>
          <div class="req">${DOT_ICON}<span>NVIDIA GPU</span></div>
          <p class="note">ryuod does not check these yet; a missing one shows as an error when the display starts.</p>
        </div>
      </div>`;
  }
}
