import { html } from "lit";
import type { Actions } from "../actions.ts";
import { heroMirror, mirrorChipText, mirrorHintShown } from "../display.ts";
import type { AppState } from "../state.ts";
import { RyuoElement } from "./ryuo-element.ts";

/**
 * The hero's desktop-mirror view: two sketched windows, the chip naming the display's state,
 * and the caption saying where KDE places and scales Virtual-RYUO.
 *
 * It shows when the hero would show the mirror. The old page's renderHero chose, most specific
 * first: ryuod down, a preview, the panel in standby, the mirror, the live background. The
 * preview is not ported yet (step 4), so this checks the other three that outrank the mirror.
 */
export function mirrorView(state: AppState, actions: Actions | undefined) {
  const status = state.display;
  const shown = state.unreachable === null && state.panel?.on !== false && heroMirror(state.displayWant, status);
  const open = !!state.desktop?.displaySettings;
  return html`<div class="mirror-view" id="mirrorView" ?hidden=${!shown}>
    <div class="win" aria-hidden="true" style="left: 8%; top: 14%; width: 46%; height: 60%; background: #181B22; border: 1px solid #2A2E38"></div>
    <div class="win" aria-hidden="true" style="left: 44%; top: 30%; width: 44%; height: 56%; background: #1B1F27; border: 1px solid #2E3340"></div>
    <div class="chip" id="mirrorChip">${mirrorChipText(status)}</div>
    <p class="caption" id="mirrorHint" ?hidden=${!mirrorHintShown(status)}><span id="mirrorHintText">Position and scale: System Settings → Display &amp; Monitor → Display Configuration → Virtual-RYUO</span><button
      class="btn mini" id="mirrorSettings" type="button" aria-label="Open Display Configuration" title="Open Display Configuration"
      ?hidden=${!open} @click=${() => actions?.openDisplaySettings()}>Open</button></p>
  </div>`;
}

/**
 * The mirror view's host inside the hero, which stays the old page's markup until the hero is
 * ported; the hero element then renders mirrorView() itself and this element goes.
 */
export class RyuoMirrorView extends RyuoElement {
  protected override render() {
    const state = this.app?.store.state;
    return state ? mirrorView(state, this.app?.actions) : null;
  }
}
