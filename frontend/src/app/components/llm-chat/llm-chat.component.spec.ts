import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';

import { LlmChatComponent } from './llm-chat.component';
import { ChatTurn, GroupsInfo, LlmChatService, MessagePosted, SeriesPoint } from '../../services/llm-chat.service';
import { WebSocketService } from '../../services/websocket.service';
import { WebSocketServiceStub } from '../../testing/websocket.stub';
import { settle } from '../../testing/change-detection';

/**
 * Change-detection regression guard for the token stream.
 *
 * The chat renders word by word only because every `TOKEN` event **replaces** the `live` signal with
 * a new object. Written as an in-place `+=` on the existing one it would keep the same reference, the
 * signal would not notify, and this `OnPush` component would stop repainting: the token counter next
 * to it would still climb (it reads another signal) while the text froze and then appeared in one
 * block at the next unrelated refresh. That is precisely the symptom reported against this page on
 * 2026-08-21, so it deserves a test rather than another manual measurement.
 *
 * Refresh goes through automatic change detection on purpose — `fixture.detectChanges()` checks the
 * view unconditionally and would hide the bug.
 */
describe('LlmChatComponent — token streaming under OnPush', () => {
  let fixture: ComponentFixture<LlmChatComponent>;
  let ws: WebSocketServiceStub;

  /**
   * Events are filtered on `conversationId === cid`, so a spec that omits the cid silently asserts
   * nothing. The cid is random per instance (persisted in localStorage), hence reading it back.
   */
  const token = (value: string, msgId = 'm-1') =>
    ws.emit({ eventType: 'TOKEN', conversationId: fixture.componentInstance.cid, msgId, value });

  const emptyGroups: GroupsInfo = {
    stream: 'chat:test', length: 0,
    tokenStream: 'chat:test:tok', tokenStreamLength: 0,
    groups: [], flags: [], stats: {}, dlqStream: 'chat:test:dlq', dlq: []
  };

  const apiStub: Partial<LlmChatService> = {
    history: () => of<ChatTurn[]>([]),
    groups: () => of(emptyGroups),
    tokenSeries: () => of<SeriesPoint[]>([]),
    postMessage: () => of<MessagePosted>({ cid: 'test', msgId: 'm-1', streamId: '1-0' }),
    reset: () => of(void 0),
    killWorker: () => of(void 0)
  };

  const bubbleText = async () => {
    await settle();
    const el = fixture.nativeElement as HTMLElement;
    return Array.from(el.querySelectorAll('.bubble.assistant .text'))
      .map(n => n.textContent ?? '')
      .join('');
  };

  beforeEach(async () => {
    // Deliberately NOT vi.useFakeTimers(): it freezes Angular's automatic change detection, so the
    // signal updates while the DOM stays stale and every case below fails for the wrong reason.
    // The component's own 1500ms REST poll is harmless here — the stub answers with an empty history.
    ws = new WebSocketServiceStub();
    await TestBed.configureTestingModule({
      imports: [LlmChatComponent],
      providers: [
        { provide: WebSocketService, useValue: ws },
        { provide: LlmChatService, useValue: apiStub }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(LlmChatComponent);
    fixture.autoDetectChanges(true);
    await settle();
  });

  it('paints the first token as soon as it arrives', async () => {
    token('Bonjour', 'm-1');

    expect(await bubbleText()).toContain('Bonjour');
  });

  it('grows the bubble token by token instead of appearing in one block', async () => {
    const lengths: number[] = [];
    for (const tok of ['Le ', 'streaming ', 'doit ', 'se ', 'voir']) {
      token(tok);
      lengths.push((await bubbleText()).length);
    }

    // Every token must be observable in the DOM, i.e. strictly increasing lengths — not one jump.
    expect(lengths).toHaveLength(5);
    for (let i = 1; i < lengths.length; i++) {
      expect(lengths[i]).toBeGreaterThan(lengths[i - 1]);
    }
    expect(await bubbleText()).toContain('Le streaming doit se voir');
  });

  it('starts a fresh bubble when a new message id begins', async () => {
    token('premier', 'm-1');
    token('second', 'm-2');

    const text = await bubbleText();
    expect(text).toContain('second');
    expect(text).not.toContain('premiersecond');
  });

  it('shows the streaming cursor while a turn is incomplete', async () => {
    token('en cours', 'm-1');
    await settle();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.bubble.assistant .cursor')).not.toBeNull();
  });
});
