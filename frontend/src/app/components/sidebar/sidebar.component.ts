import { Component, Input, Output, EventEmitter, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';

interface MenuItem {
  id: string;
  label: string;
  icon: string;
  route: string;
}

interface MenuCategory {
  id: string;
  label: string;
  items: MenuItem[];
}

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [CommonModule, RouterModule],
  template: `
    <aside class="sidebar" [class.collapsed]="isCollapsed">
      <div class="sidebar-header">
        <button
          class="toggle-btn"
          (click)="toggleSidebarState()"
          [attr.aria-label]="isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'">
          <span class="toggle-icon" [class.rotated]="isCollapsed">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="15,18 9,12 15,6"></polyline>
            </svg>
          </span>
        </button>
      </div>

      <nav class="nav-menu">
        <!-- Standalone items -->
        <ul class="menu-list">
          @for (item of standaloneItems; track item.id) {
            <li class="menu-item">
              <a [routerLink]="item.route" routerLinkActive="active" class="menu-link" [attr.title]="isCollapsed ? item.label : null">
                <span class="menu-icon" [innerHTML]="item.icon"></span>
                <span class="menu-label" [class.hidden]="isCollapsed">{{ item.label }}</span>
              </a>
            </li>
          }
        </ul>

        <!-- Categories -->
        @for (category of categories; track category.id) {
          <div class="menu-category">
            <div class="category-header" [class.hidden]="isCollapsed">
              <span class="category-label">{{ category.label }}</span>
            </div>
            <ul class="menu-list">
              @for (item of category.items; track item.id) {
                <li class="menu-item">
                  <a [routerLink]="item.route" routerLinkActive="active" class="menu-link" [attr.title]="isCollapsed ? item.label : null">
                    <span class="menu-icon" [innerHTML]="item.icon"></span>
                    <span class="menu-label" [class.hidden]="isCollapsed">{{ item.label }}</span>
                  </a>
                </li>
              }
            </ul>
          </div>
        }
      </nav>
    </aside>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [`
    .sidebar {
      width: 250px;
      background-color: #163341;
      border-right: 1px solid #334155;
      position: fixed;
      left: 0;
      top: 50px;
      height: calc(100vh - 50px);
      transition: width 0.3s ease;
      z-index: 999;
      overflow: hidden;
    }

    .sidebar.collapsed {
      width: 60px;
    }

    .sidebar-header {
      padding: 16px;
      border-bottom: 1px solid #334155;
    }

    .toggle-btn {
      background: none;
      border: none;
      color: #94a3b8;
      cursor: pointer;
      padding: 8px;
      border-radius: 6px;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .toggle-btn:hover {
      background-color: #334155;
      color: #e2e8f0;
    }

    .toggle-icon {
      display: flex;
      transition: transform 0.3s ease;
    }

    .toggle-icon.rotated {
      transform: rotate(180deg);
    }

    .nav-menu {
      padding: 16px 0;
    }

    .menu-list {
      list-style: none;
      margin: 0;
      padding: 0;
    }

    .menu-item {
      margin-bottom: 4px;
    }

    .menu-link {
      display: flex;
      align-items: center;
      padding: 12px 16px;
      color: #94a3b8;
      text-decoration: none;
      transition: all 0.2s ease;
      border-radius: 0;
      position: relative;
    }

    .menu-link:hover {
      background-color: #334155;
      color: #e2e8f0;
    }

    .menu-link.active {
      background-color: #DCFF1F;
      color: #091A23;
    }

    .menu-link.active::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 3px;
      background-color: #091A23;
    }

    .menu-icon {
      width: 20px;
      height: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-right: 12px;
      flex-shrink: 0;
    }

    .menu-label {
      font-weight: 500;
      white-space: nowrap;
      transition: opacity 0.3s ease;
    }

    .menu-label.hidden {
      opacity: 0;
    }

    .menu-category {
      margin-top: 16px;
    }

    .category-header {
      padding: 8px 16px 6px;
      color: #64748b;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .category-header.hidden {
      display: none;
    }

    .sidebar.collapsed .menu-link {
      justify-content: center;
      padding: 12px;
    }

    .sidebar.collapsed .menu-icon {
      margin-right: 0;
    }

    @media (max-width: 768px) {
      .sidebar {
        transform: translateX(-100%);
        transition: transform 0.3s ease;
      }

      .sidebar:not(.collapsed) {
        transform: translateX(0);
      }
    }
  `]
})
export class SidebarComponent {
  @Input() isCollapsed = false;
  @Output() toggleSidebar = new EventEmitter<boolean>();

  // No standalone items - all items are categorized
  standaloneItems: MenuItem[] = [];

  // Menu categories with their items
  categories: MenuCategory[] = [
    {
      id: 'stream',
      label: 'Stream',
      items: [
        {
          id: 'dlq',
          label: 'DLQ',
          icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                   <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                   <polyline points="7.5,4.21 12,6.81 16.5,4.21"></polyline>
                   <polyline points="7.5,19.79 7.5,14.6 3,12"></polyline>
                   <polyline points="21,12 16.5,14.6 16.5,19.79"></polyline>
                 </svg>`,
          route: '/dlq'
        },
        {
          id: 'request-reply',
          label: 'Request/Reply',
          icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                   <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                   <line x1="9" y1="10" x2="15" y2="10"></line>
                   <line x1="12" y1="7" x2="12" y2="13"></line>
                 </svg>`,
          route: '/request-reply'
        },
        {
          id: 'work-queue',
          label: 'Work Queue',
          icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                   <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                   <line x1="8" y1="12" x2="16" y2="12"></line>
                   <line x1="8" y1="8" x2="16" y2="8"></line>
                   <line x1="8" y1="16" x2="16" y2="16"></line>
                 </svg>`,
          route: '/work-queue'
        },
        {
          id: 'fan-out',
          label: 'Fan-Out',
          icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                   <circle cx="12" cy="5" r="3"></circle>
                   <circle cx="5" cy="19" r="3"></circle>
                   <circle cx="12" cy="19" r="3"></circle>
                   <circle cx="19" cy="19" r="3"></circle>
                   <line x1="12" y1="8" x2="5" y2="16"></line>
                   <line x1="12" y1="8" x2="12" y2="16"></line>
                   <line x1="12" y1="8" x2="19" y2="16"></line>
                 </svg>`,
          route: '/fan-out'
        },
        {
          id: 'topic-routing',
          label: 'Key Routing',
          icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                   <path d="M16 3h5v5"></path>
                   <path d="M8 3H3v5"></path>
                   <path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3"></path>
                   <path d="m15 9 6-6"></path>
                   <circle cx="18" cy="18" r="3"></circle>
                   <circle cx="6" cy="18" r="3"></circle>
                 </svg>`,
          route: '/topic-routing'
        },
        {
          id: 'content-routing',
          label: 'Content-Based Routing',
          icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                   <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                   <polyline points="14 2 14 8 20 8"></polyline>
                   <path d="M9 15l2 2 4-4"></path>
                 </svg>`,
          route: '/content-routing'
        },
        {
          id: 'scheduled-messages',
          label: 'Scheduled Messages',
          icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                   <circle cx="12" cy="12" r="10"></circle>
                   <polyline points="12 6 12 12 16 14"></polyline>
                 </svg>`,
          route: '/scheduled-messages'
        }
      ]
    },
    {
      id: 'messaging-patterns',
      label: 'Messaging Patterns',
      items: [
        {
          id: 'per-key-serialized',
          label: 'Per-Key Serialized',
          icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                   <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
                   <path d="M2 17l10 5 10-5"></path>
                   <path d="M2 12l10 5 10-5"></path>
                 </svg>`,
          route: '/per-key-serialized'
        },
        {
          id: 'token-bucket',
          label: 'Token Bucket',
          icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                   <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path>
                   <line x1="3" y1="6" x2="21" y2="6"></line>
                   <path d="M16 10a4 4 0 0 1-8 0"></path>
                 </svg>`,
          route: '/token-bucket'
        },
        {
          id: 'llm-chat',
          label: 'LLM Chat',
          icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                   <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                 </svg>`,
          route: '/llm-chat'
        }
      ]
    },
    {
      id: 'pubsub',
      label: 'Pub/Sub',
      items: [
        {
          id: 'pubsub',
          label: 'Pub/Sub',
          icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                   <circle cx="12" cy="12" r="3"></circle>
                   <path d="M12 1v6m0 6v6m8.66-15.66l-4.24 4.24m-4.24 4.24l-4.24 4.24m15.66-8.66l-6 0m-6 0l-6 0m15.66 8.66l-4.24-4.24m-4.24-4.24l-4.24-4.24"></path>
                 </svg>`,
          route: '/pubsub'
        },
        {
          id: 'pubsub-topic-routing',
          label: 'Topic Routing',
          icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                   <circle cx="12" cy="12" r="3"></circle>
                   <path d="M12 1v6m0 6v6m8.66-15.66l-4.24 4.24m-4.24 4.24l-4.24 4.24m15.66-8.66l-6 0m-6 0l-6 0m15.66 8.66l-4.24-4.24m-4.24-4.24l-4.24-4.24"></path>
                   <path d="M16 3h5v5"></path>
                 </svg>`,
          route: '/pubsub-topic-routing'
        }
      ]
    }
  ];

  toggleSidebarState(): void {
    this.isCollapsed = !this.isCollapsed;
    this.toggleSidebar.emit(this.isCollapsed);
  }
}