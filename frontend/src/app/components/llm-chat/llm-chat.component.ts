import {
  Component, OnDestroy, OnInit, signal, computed, inject,
  ElementRef, ViewChild, AfterViewChecked,
  ChangeDetectionStrategy
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { WebSocketService } from '../../services/websocket.service';
import { ChatTurn, GroupsInfo, LlmChatService, SeriesPoint } from '../../services/llm-chat.service';
import { MermaidDiagramComponent } from '../mermaid-diagram/mermaid-diagram.component';
import { DiagramDefinitionsService } from '../../services/diagram-definitions.service';

interface ChatMessage {
  role: string; // 'user' | 'assistant' | 'system' (moderation policy notice)
  content: string;
  complete: boolean;
  msgId?: string;
  streamId?: string;
}

/** Shape of the WebSocket events the backend broadcasts for pattern #12. */
interface LlmChatWsEvent {
  eventType: 'TOKEN' | 'ASSISTANT_MESSAGE' | 'USER_MESSAGE' | 'CONVERSATION_RESET';
  conversationId?: string;
  msgId?: string;
  value?: string;
  streamId?: string;
}

/**
 * LLM Chat (pattern #12) page.
 *
 * <p>The conversation stream (`chat:{cid}`) is the source of truth: it's loaded/polled via REST so
 * the chat always reflects Redis even if the WebSocket hiccups. The WebSocket adds the live
 * token-by-token animation on top. Events are broadcast filtered by our (random, unguessable) cid.
 */
@Component({
  selector: 'app-llm-chat',
  standalone: true,
  imports: [CommonModule, FormsModule, MermaidDiagramComponent],
  templateUrl: './llm-chat.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./llm-chat.component.scss']
})
export class LlmChatComponent implements OnInit, OnDestroy, AfterViewChecked {
  private ws = inject(WebSocketService);
  private api = inject(LlmChatService);
  readonly diagrams = inject(DiagramDefinitionsService);

  @ViewChild('messagesEl') private messagesEl?: ElementRef<HTMLDivElement>;
  @ViewChild('streamEl') private streamEl?: ElementRef<HTMLDivElement>;

  /** localStorage key holding the persisted conversation id (see {@link cid}). */
  private static readonly CID_STORAGE_KEY = 'redis-llm-chat-cid';

  /**
   * Conversation identity, keyed as {@code companyId:userId} (colon-separated) so the Redis stream
   * reads like a real multi-tenant key: {@code chat:acme-corp:u-<random>}. The userId keeps a random
   * suffix so the cid also acts as an unguessable capability (no auth — ADR-0008): the server only
   * delivers a conversation's events to sessions that subscribed with its exact cid.
   *
   * <p>Persisted in {@code localStorage} so a page reload restores the same conversation — the Redis
   * stream {@code chat:{cid}} is the source of truth and is reloaded via REST on init. Generated once
   * per browser; only <b>Reset</b> deletes the conversation's Redis keys, and it keeps the same cid so
   * the (now empty) conversation continues under the same identity.
   */
  readonly companyId = 'acme-corp';
  readonly cid = LlmChatComponent.loadOrCreateCid(this.companyId);

  private static loadOrCreateCid(companyId: string): string {
    const fresh = () => `${companyId}:u-${crypto.randomUUID().slice(0, 8)}`;
    try {
      const stored = localStorage.getItem(LlmChatComponent.CID_STORAGE_KEY);
      if (stored) {
        return stored;
      }
      const cid = fresh();
      localStorage.setItem(LlmChatComponent.CID_STORAGE_KEY, cid);
      return cid;
    } catch {
      // localStorage unavailable (private mode / SSR) — fall back to an ephemeral cid.
      return fresh();
    }
  }

  /** Source of truth: completed turns from Redis (via REST). */
  private readonly historyTurns = signal<ChatTurn[]>([]);
  /** In-flight assistant reply being streamed over WebSocket, overlaid until history catches up. */
  private readonly live = signal<{ msgId: string; content: string } | null>(null);
  /** Optimistically shown user message until the next history poll includes it. */
  private readonly pendingUser = signal<string | null>(null);

  readonly connected = signal(false);
  readonly showInternals = signal(true);
  readonly groups = signal<GroupsInfo | null>(null);
  /** Analytics time series (user tokens per message) for the chart. */
  readonly series = signal<SeriesPoint[]>([]);
  draft = '';

  /** SVG chart geometry (viewBox 0 0 1000 160): bars positioned on a real time x-axis + gridlines. */
  readonly chart = computed(() => {
    const pts = this.series();
    const W = 1000;
    const H = 160;
    const padX = 16;
    const padTop = 12;
    const padBot = 14;
    const n = pts.length;
    const max = Math.max(1, ...pts.map(p => p.value));
    const yFor = (v: number) => (H - padBot) - (v / max) * (H - padTop - padBot);
    const baseY = yFor(0);
    const grid = [max, max / 2, 0].map(v => ({ y: yFor(v).toFixed(1), label: String(Math.round(v)) }));
    if (n === 0) {
      return { W, H, n, bars: [], grid, max, startLabel: '', endLabel: '' };
    }
    const tMin = pts[0].ts;
    const tMax = pts[n - 1].ts;
    const span = Math.max(1, tMax - tMin);
    const xFor = (ts: number) => (n === 1 ? W / 2 : padX + ((ts - tMin) / span) * (W - 2 * padX));
    const bw = 16;
    const bars = pts.map(p => {
      const cx = xFor(p.ts);
      const y = yFor(p.value);
      return {
        x: (cx - bw / 2).toFixed(1),
        y: y.toFixed(1),
        w: bw,
        h: Math.max(1, baseY - y).toFixed(1),
        v: p.value,
        xPct: ((cx / W) * 100).toFixed(2),
        time: this.hms(p.ts)
      };
    });
    return { W, H, n, bars, grid, max };
  });

  /** Format an epoch-ms bucket timestamp as HH:MM:SS (local time) for the x-axis ticks. */
  private hms(ts: number): string {
    const d = new Date(ts);
    const p = (x: number) => String(x).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  /** Rendered chat = history turns + optimistic user + live streaming bubble (deduped). */
  readonly messages = computed<ChatMessage[]>(() => {
    const turns = this.historyTurns();
    const out: ChatMessage[] = turns.map(t => ({
      role: t.role ?? 'user',
      content: t.content ?? '',
      complete: true,
      msgId: t.msgId,
      streamId: t.streamId
    }));
    const pu = this.pendingUser();
    if (pu && !turns.some(t => t.role === 'user' && t.content === pu)) {
      out.push({ role: 'user', content: pu, complete: true });
    }
    const lt = this.live();
    if (lt && !turns.some(t => t.msgId === lt.msgId)) {
      out.push({ role: 'assistant', content: lt.content, complete: false, msgId: lt.msgId });
    }
    return out;
  });

  /** Raw conversation-stream entries (with their Redis ids) for the internals panel. */
  readonly streamEntries = computed(() => this.historyTurns());

  private subs: Subscription[] = [];
  private pollTimer?: ReturnType<typeof setInterval>;
  private scrollScheduled = false;

  ngOnInit(): void {
    this.ws.connect();
    this.subs.push(
      this.ws.getEvents().subscribe(e => this.handleEvent(e as unknown as LlmChatWsEvent)),
      this.ws.getConnectionStatus().subscribe(status => {
        this.connected.set(status);
        // (Re)subscribe on every (re)connection so the server delivers only this cid's events.
        if (status) {
          this.ws.send({ type: 'subscribe', cid: this.cid });
        }
      })
    );
    this.refresh();
    // REST is the safety net: keep the transcript + internals in sync even if the socket drops.
    this.pollTimer = setInterval(() => this.refresh(), 1500);
  }

  ngAfterViewChecked(): void {
    // Pin both scrollers to the bottom so new messages/tokens are never missed. We pin synchronously
    // AND once more deferred (setTimeout 0) because the last bubble's height is often laid out after
    // this hook runs — the deferred pass runs post-layout and catches it. Idempotent at the bottom.
    this.pinToBottom();
    if (!this.scrollScheduled) {
      this.scrollScheduled = true;
      setTimeout(() => {
        this.scrollScheduled = false;
        this.pinToBottom();
      }, 0);
    }
  }

  private pinToBottom(): void {
    const m = this.messagesEl?.nativeElement;
    if (m) {
      m.scrollTop = m.scrollHeight;
    }
    const s = this.streamEl?.nativeElement;
    if (s) {
      s.scrollTop = s.scrollHeight;
    }
  }

  /** Pin after the browser has laid out late-arriving content (streamed reply, polled turn). */
  private deferPin(): void {
    setTimeout(() => this.pinToBottom(), 120);
  }

  ngOnDestroy(): void {
    this.subs.forEach(s => s.unsubscribe());
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
  }

  handleEvent(event: LlmChatWsEvent): void {
    if (event.conversationId !== this.cid) {
      return;
    }
    switch (event.eventType) {
      case 'TOKEN': {
        const lt = this.live();
        const value = event.value ?? '';
        this.live.set(lt && lt.msgId === event.msgId
          ? { msgId: lt.msgId, content: lt.content + value }
          : { msgId: event.msgId ?? '', content: value });
        this.deferPin();
        break;
      }
      case 'ASSISTANT_MESSAGE':
        this.live.set({ msgId: event.msgId ?? '', content: event.value ?? '' });
        this.refresh(); // pull the now-complete assistant turn into history
        this.deferPin();
        break;
      case 'CONVERSATION_RESET':
        this.clearView();
        break;
      default:
        break;
    }
  }

  send(): void {
    const content = this.draft.trim();
    if (!content) {
      return;
    }
    this.sendContent(content);
    this.draft = '';
  }

  /** Cycles through messages that trip different moderation keywords on each click. */
  private readonly moderationSamples = [
    'Can you remind me my account password?',            // -> "password"
    'Store this for later: my api key is sk-live-abc123', // -> "api key"
    'My SSN is 078-05-1120 — is that on file?'            // -> "ssn"
  ];
  private modIndex = 0;

  /** Demo helper: send a message that trips cg:moderation (different keyword each click). */
  moderationDemo(): void {
    const msg = this.moderationSamples[this.modIndex % this.moderationSamples.length];
    this.modIndex++;
    this.sendContent(msg);
  }

  private sendContent(content: string): void {
    this.pendingUser.set(content);
    this.api.postMessage(this.cid, content).subscribe({
      next: () => setTimeout(() => this.refresh(), 300),
      error: err => console.error('postMessage failed', err)
    });
  }

  reset(): void {
    this.api.reset(this.cid).subscribe({
      next: () => this.clearView(),
      error: err => console.error('reset failed', err)
    });
  }

  /** Demo helper: send a poison message that fails every attempt → routed to the DLQ. */
  dlqDemo(): void {
    this.sendContent('/fail this request always errors out');
  }

  /** Demo helper: trigger a long reply so the token-by-token streaming is clearly visible. */
  longTextDemo(): void {
    this.sendContent('Write a long text explaining Redis Streams for LLM chat.');
  }

  killWorker(): void {
    // Arm the one-shot crash, then immediately send a sample message so the whole
    // crash → XAUTOCLAIM recovery demo runs from a single click (no typing needed).
    this.api.killWorker(this.cid).subscribe({
      next: () => this.sendContent('This reply crashes mid-generation — watch it auto-recover.'),
      error: err => console.error('kill-worker failed', err)
    });
  }

  refresh(): void {
    this.loadHistory();
    this.refreshGroups();
    this.loadSeries();
  }

  private loadSeries(): void {
    this.api.tokenSeries(this.cid).subscribe({
      next: pts => this.series.set(pts),
      error: () => { /* transient */ }
    });
  }

  toggleInternals(): void {
    this.showInternals.update(v => !v);
  }

  private loadHistory(): void {
    this.api.history(this.cid).subscribe({
      next: turns => {
        this.historyTurns.set(turns);
        const pu = this.pendingUser();
        if (pu && turns.some(t => t.role === 'user' && t.content === pu)) {
          this.pendingUser.set(null);
        }
        const lt = this.live();
        if (lt && turns.some(t => t.msgId === lt.msgId)) {
          this.live.set(null);
        }
        this.deferPin();
      },
      error: () => { /* transient; next poll retries */ }
    });
  }

  private refreshGroups(): void {
    this.api.groups(this.cid).subscribe({
      next: g => this.groups.set(g),
      error: () => this.groups.set(null)
    });
  }

  private clearView(): void {
    this.historyTurns.set([]);
    this.live.set(null);
    this.pendingUser.set(null);
    this.series.set([]);
    this.refreshGroups();
  }
}
