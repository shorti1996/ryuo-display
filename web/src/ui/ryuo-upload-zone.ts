import { html, nothing } from "lit";
import { uploadActive } from "../upload.ts";
import { RyuoElement } from "./ryuo-element.ts";

const ACCEPT = "video/*,image/*,.mp4,.mov,.mkv,.webm,.avi,.m4v,.png,.jpg,.jpeg,.webp,.gif,.bmp";
const UPLOAD_ICON = html`<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#C9CBD0" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="M6 10l6-6 6 6"/><path d="M4 20h16"/></svg>`;
// A file dropped beside the zone would otherwise make the browser open it in place of this page.
const keepPage = (event: Event) => event.preventDefault();

/**
 * The upload drop zone: drop a file on it or Browse, with the shape the conversion uses, and the
 * progress bar and Cancel while an upload runs. The host is the zone (#dropZone, class "drop"),
 * the last cell of the Custom tiles' grid; the status line under the grid is the Background
 * tab's. The upload starts as soon as a file is chosen (actions.upload).
 */
export class RyuoUploadZone extends RyuoElement {
  #over = (event: DragEvent) => {
    event.preventDefault();
    this.classList.add("over");
  };
  #leave = (event: DragEvent) => {
    if (!this.contains(event.relatedTarget as Node | null)) this.classList.remove("over");
  };
  #drop = (event: DragEvent) => {
    event.preventDefault();
    this.classList.remove("over");
    this.#upload(event.dataTransfer?.files[0]);
  };

  override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener("dragenter", this.#over);
    this.addEventListener("dragover", this.#over);
    this.addEventListener("dragleave", this.#leave);
    this.addEventListener("drop", this.#drop);
    window.addEventListener("dragover", keepPage);
    window.addEventListener("drop", keepPage);
  }

  override disconnectedCallback(): void {
    this.removeEventListener("dragenter", this.#over);
    this.removeEventListener("dragover", this.#over);
    this.removeEventListener("dragleave", this.#leave);
    this.removeEventListener("drop", this.#drop);
    window.removeEventListener("dragover", keepPage);
    window.removeEventListener("drop", keepPage);
    super.disconnectedCallback();
  }

  #upload(file: File | undefined): void {
    // The shape is read when the file arrives: the select has no other use.
    const fit = this.querySelector<HTMLSelectElement>("#upFit")?.value ?? "crop";
    this.app?.actions.upload(file, fit);
  }

  #picked(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.#upload(input.files?.[0]);
    // So that choosing the same file again fires change again.
    input.value = "";
  }

  protected override render() {
    const shown = this.app?.store.state.upload.shown ?? null;
    const active = uploadActive(shown);
    // No value attribute while the share is unknown: the bar then shows that it is busy.
    const value = active && shown?.progress != null ? String(shown.progress) : nothing;
    return html`${UPLOAD_ICON}
      <span>Drop a video or image to upload it</span>
      <div class="row">
        <button class="btn" id="upBrowse" type="button" ?disabled=${active}
          @click=${() => this.querySelector<HTMLInputElement>("#upFile")?.click()}>Browse</button>
        <label for="upFit" class="sr-only">Shape</label>
        <select id="upFit">
          <option value="crop">Fill (crop edges)</option>
          <option value="pad">Fit (black bars)</option>
        </select>
      </div>
      <input type="file" id="upFile" accept=${ACCEPT} hidden @change=${this.#picked}>
      <progress id="upBar" max="1" ?hidden=${!active} value=${value}></progress>
      <button class="btn" id="upCancel" type="button" ?hidden=${!active} @click=${() => this.app?.actions.cancelUpload()}>Cancel upload</button>`;
  }
}
