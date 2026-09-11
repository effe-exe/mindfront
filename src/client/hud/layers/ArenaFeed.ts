import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";

/**
 * MindFront: live feed of AI decisions and reasoning for spectators.
 * Subscribes to the arena brain's SSE endpoint (arena/brain.ts, port 9100)
 * for the game in the URL. Renders nothing until the feed connects, so the
 * element is inert on pages that are not arena matches.
 */
type FeedLine =
  | {
      kind: "decision";
      t: number;
      player: string;
      model: string;
      fallback: boolean;
      reasoning: string;
      sent: unknown[];
      dropped: { reason: string }[];
    }
  | { kind: "sim"; t: number; type: string; text: string };

const MAX_LINES = 40;

@customElement("arena-feed")
export class ArenaFeed extends LitElement {
  @state() private lines: FeedLine[] = [];
  @state() private connected = false;
  @state() private collapsed = false;
  private source: EventSource | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    const gameID = location.pathname.match(/\/game\/([A-Za-z0-9]+)/)?.[1];
    if (!gameID) return;
    const port = new URLSearchParams(location.search).get("feed") ?? "9100";
    this.source = new EventSource(
      `http://${location.hostname}:${port}/feed/${gameID}`,
    );
    this.source.onopen = () => (this.connected = true);
    this.source.onerror = () => (this.connected = false);
    this.source.onmessage = (e) => {
      const line = JSON.parse(e.data) as FeedLine;
      this.lines = [...this.lines, line].slice(-MAX_LINES);
      this.updateComplete.then(() => {
        const box = this.querySelector(".arena-feed-scroll");
        if (box) box.scrollTop = box.scrollHeight;
      });
    };
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.source?.close();
  }

  private clock(t: number) {
    const s = Math.floor(t / 10);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  render() {
    if (!this.connected && this.lines.length === 0) return html``;
    return html`
      <div
        class="fixed bottom-4 left-4 z-40 w-[26rem] max-w-[calc(100vw-2rem)] rounded-lg bg-black/70 text-white text-sm shadow-lg backdrop-blur pointer-events-auto"
      >
        <button
          class="flex w-full items-center justify-between px-3 py-1.5 font-semibold tracking-wide"
          @click=${() => (this.collapsed = !this.collapsed)}
        >
          <span>AI FEED</span>
          <span class="text-xs opacity-70">
            ${this.connected ? "live" : "offline"} · ${this.collapsed ? "show" : "hide"}
          </span>
        </button>
        ${this.collapsed
          ? ""
          : html`<div class="arena-feed-scroll max-h-72 overflow-y-auto px-3 pb-2 space-y-1.5">
              ${this.lines.map((l) =>
                l.kind === "decision"
                  ? html`<div>
                      <span class="opacity-50 tabular-nums">${this.clock(l.t)}</span>
                      <span class="font-semibold text-sky-300">${l.player}</span>
                      <span class="opacity-50 text-xs">${l.model.split("/").pop()}</span>
                      <div class="${l.fallback ? "italic opacity-60" : ""}">${l.reasoning}</div>
                      ${l.dropped.length
                        ? html`<div class="text-xs text-amber-300/80">
                            ${l.dropped.map((d) => d.reason).join(" · ")}
                          </div>`
                        : ""}
                    </div>`
                  : html`<div class="text-emerald-300">
                      <span class="opacity-50 tabular-nums">${this.clock(l.t)}</span>
                      ${l.text}
                    </div>`,
              )}
            </div>`}
      </div>
    `;
  }
}
