import { Component, ChangeDetectionStrategy } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { HeaderComponent } from './components/header/header.component';
import { SidebarComponent } from './components/sidebar/sidebar.component';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, HeaderComponent, SidebarComponent, CommonModule],
  template: `
    <div class="app-container">
      <app-header></app-header>
      <div class="main-container">
        <app-sidebar 
          [isCollapsed]="sidebarCollapsed"
          (toggleSidebar)="onToggleSidebar($event)">
        </app-sidebar>
        <main class="content-area" [class.sidebar-collapsed]="sidebarCollapsed">
          <router-outlet></router-outlet>
        </main>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [`
    .app-container {
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    .main-container {
      flex: 1;
      display: flex;
      overflow: hidden;
    }

    .content-area {
      flex: 1;
      padding: 24px;
      background-color: #f8fafc;
      overflow-y: auto;
      transition: margin-left 0.3s ease;
      margin-left: 250px;
    }

    .content-area.sidebar-collapsed {
      margin-left: 60px;
    }

    @media (max-width: 768px) {
      .content-area {
        margin-left: 0;
      }
      
      .content-area.sidebar-collapsed {
        margin-left: 0;
      }
    }
  `]
})
export class AppComponent {
  sidebarCollapsed = false;

  onToggleSidebar(collapsed: boolean): void {
    this.sidebarCollapsed = collapsed;
  }
}
