import {
  AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, HostListener, ViewChild, input, output
} from '@angular/core';

/**
 * Modal confirmation for a destructive action, replacing the native `confirm()`.
 *
 * Rendered by the parent inside an `@if`, rather than through an overlay service: this page needs one
 * dialog, and a CDK overlay would pull `@angular/material`'s theming into a codebase whose styling is
 * entirely hand-written.
 *
 * The backdrop is deliberately **not** click-to-dismiss. Dismissing a destructive confirmation by a
 * stray click outside it is a misfeature, and a clickable non-button element would also need a role,
 * a tabindex and a key handler to stay accessible — three obligations for a behaviour we do not want.
 * Escape and the Cancel button are the two ways out.
 */
@Component({
  selector: 'app-confirm-dialog',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="backdrop">
      <div class="dialog" role="dialog" aria-modal="true"
           [attr.aria-labelledby]="titleId" [attr.aria-describedby]="messageId">
        <header class="dialog-header">
          <span class="icon" aria-hidden="true">⚠</span>
          <h2 class="dialog-title" [id]="titleId">{{ title() }}</h2>
        </header>

        <div class="dialog-body">
          <p class="message" [id]="messageId">{{ message() }}</p>
          @if (detail()) {
            <p class="detail">{{ detail() }}</p>
          }
        </div>

        <footer class="dialog-actions">
          <button #cancelBtn type="button" class="btn cancel" (click)="cancelled.emit()">
            {{ cancelLabel() }}
          </button>
          <button type="button" class="btn confirm" (click)="confirmed.emit()">
            {{ confirmLabel() }}
          </button>
        </footer>
      </div>
    </div>
    `,
  styles: [`
    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: rgba(15, 23, 42, 0.55);
    }

    .dialog {
      width: 100%;
      max-width: 420px;
      background: white;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      box-shadow: 0 18px 40px rgba(15, 23, 42, 0.25);
      overflow: hidden;
    }

    .dialog-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 16px;
      border-bottom: 1px solid #e2e8f0;
      background: linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%);
    }

    .icon { font-size: 18px; }

    .dialog-title {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
      color: #1e293b;
    }

    .dialog-body { padding: 16px; }

    .message {
      margin: 0;
      font-size: 14px;
      line-height: 1.55;
      color: #1e293b;
    }

    .detail {
      margin: 10px 0 0;
      font-size: 13px;
      line-height: 1.5;
      color: #64748b;
    }

    .dialog-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      padding: 12px 16px;
      border-top: 1px solid #e2e8f0;
      background: #f8fafc;
    }

    .btn {
      padding: 9px 16px;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .btn:hover { transform: translateY(-1px); }
    .btn:active { transform: translateY(0); }

    .btn.cancel {
      background: white;
      border: 1px solid #cbd5e1;
      color: #475569;
    }

    .btn.cancel:hover { background: #f1f5f9; }

    .btn.confirm {
      background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
      color: white;
    }

    .btn.confirm:hover { background: linear-gradient(135deg, #d97706 0%, #b45309 100%); }

    .btn:focus-visible {
      outline: 2px solid #3b82f6;
      outline-offset: 2px;
    }
  `]
})
export class ConfirmDialogComponent implements AfterViewInit {
  readonly title = input.required<string>();
  readonly message = input.required<string>();
  /** Optional second line: what happens *after* the action, when that is not obvious. */
  readonly detail = input<string>('');
  readonly confirmLabel = input('Confirm');
  readonly cancelLabel = input('Cancel');

  readonly confirmed = output<void>();
  readonly cancelled = output<void>();

  /** Static ids: only one of these dialogs is ever open at a time. */
  readonly titleId = 'confirm-dialog-title';
  readonly messageId = 'confirm-dialog-message';

  @ViewChild('cancelBtn') private cancelButton?: ElementRef<HTMLButtonElement>;

  /**
   * Opens with the *safe* choice focused, so a stray Enter cannot destroy anything, and so keyboard
   * users start inside the dialog rather than behind it.
   */
  ngAfterViewInit(): void {
    this.cancelButton?.nativeElement.focus();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.cancelled.emit();
  }
}
